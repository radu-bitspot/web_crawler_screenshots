const puppeteer = require('puppeteer');
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const cluster = require('cluster');
const os = require('os');
const fetch = require('node-fetch');

// Determine number of CPU cores to use (leave one core free for OS operations)
const numCPUs = Math.max(1, os.cpus().length - 1);

// Browser pool configuration
const BROWSER_POOL_SIZE = 3; // Maximum number of concurrent browser instances
let browserPool = [];
let activeBrowsers = 0;

// Simple in-memory database for screenshots
const screenshotDatabase = {
  domains: {},
  addScreenshot: function(screenshot) {
    const { domain } = screenshot;
    if (!this.domains[domain]) {
      this.domains[domain] = [];
    }
    this.domains[domain].push(screenshot);

    // Keep only the most recent N screenshots per domain
    const maxScreenshotsPerDomain = 5;
    if (this.domains[domain].length > maxScreenshotsPerDomain) {
      // Sort by timestamp (newest first)
      this.domains[domain].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      // Keep only the most recent ones
      this.domains[domain] = this.domains[domain].slice(0, maxScreenshotsPerDomain);
    }
  },
  getScreenshotsByDomain: function(domain) {
    return this.domains[domain] || [];
  },
  getAllDomains: function() {
    return Object.keys(this.domains).map(domain => ({
      name: domain,
      screenshots: this.domains[domain],
      screenshotCount: this.domains[domain].length
    }));
  }
};

// Check if this is the master process
if (cluster.isMaster) {
  console.log(`Master process ${process.pid} is running`);
  console.log(`Setting up ${numCPUs} worker processes`);

  // Fork workers equal to number of CPUs
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  // Handle worker exit and restart
  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died with code: ${code} and signal: ${signal}`);
    console.log('Starting a new worker');
    cluster.fork();
  });
} else {
  // Worker processes share the same port
  const app = express();
  const port = 3005;

  app.use(bodyParser.json());

  // Enable CORS for all domains
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, translate-to-romanian');
    
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }
    next();
  });

  // Helper function to sanitize filenames
  const sanitizeFilename = (url) => {
    try {
      const { hostname, pathname } = new URL(url);
      // Get the section from pathname (remove leading and trailing slashes)
      const section = pathname.replace(/^\/|\/$/g, '');
      
      // Create a safe filename by removing invalid characters
      if (!section || section === '') {
        // This is homepage
        return hostname.replace(/[^a-z0-9-]/gi, '_');
      } else {
        // This is a section page
        return `${hostname}-${section}`.replace(/[^a-z0-9-]/gi, '_');
      }
    } catch (error) {
      console.error(`Invalid URL: ${url}`);
      return 'invalid_url';
    }
  };

  // Helper function to generate unique filename
  const generateUniqueFilename = (url) => {
    const sanitized = sanitizeFilename(url);
    if (sanitized === 'invalid_url') {
      return `screenshot-invalid-url-${Date.now()}.png`;
    }
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    return `screenshot-${sanitized}-${timestamp}.png`;
  };

  // Helper function to get a browser from the pool or create a new one
  const getBrowser = async () => {
    // Check if we can create a new browser
    if (activeBrowsers < BROWSER_POOL_SIZE) {
      activeBrowsers++;
      console.log(`Creating new browser. Active browsers: ${activeBrowsers}`);
      return await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
    }
    
    // Wait for a browser to become available
    return new Promise((resolve) => {
      const checkInterval = setInterval(async () => {
        if (activeBrowsers < BROWSER_POOL_SIZE) {
          clearInterval(checkInterval);
          activeBrowsers++;
          console.log(`Creating new browser after wait. Active browsers: ${activeBrowsers}`);
          resolve(await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox']
          }));
        }
      }, 100);
    });
  };

  // Helper function to release a browser back to the pool
  const releaseBrowser = async (browser) => {
    try {
      await browser.close();
    } catch (error) {
      console.error('Error closing browser:', error);
    }
    activeBrowsers--;
    console.log(`Browser released. Active browsers: ${activeBrowsers}`);
  };

  // Helper function to process a single URL and take a screenshot
  const processUrl = async (url, targetLang, screenshotsDir, userId = null, benchmarkId = null, sourceLang = 'auto') => {
    const browser = await getBrowser();
    
    try {
      const page = await browser.newPage();
      
      // Configure page to block cookies
      await page.setCookie(); // Clear any existing cookies
      
      // Try to determine if this is a shopping site from the URL
      const isLikelyShop = url.toLowerCase().match(/shop|store|cart|product|ecommerce|buy|purchase|mall/);
      
      // First load the page with all content to check image count and page type
      console.log(`Initial page analysis for: ${url}`);
      
      try {
        await page.goto(url, { 
          waitUntil: 'domcontentloaded',
          timeout: 5000 // 5 second timeout
        });
      } catch (initialError) {
        // Continue even if timeout, we'll analyze what loaded
        console.log(`Initial page analysis timed out, but continuing with analysis`);
      }
      
      // Count the images on the page and determine if it's image-heavy
      const pageAnalysis = await page.evaluate(() => {
        const images = document.querySelectorAll('img');
        const imageCount = images.length;
        
        // Check if it's a shop by looking for shop-related elements
        const shopElements = [
          'add to cart',
          'add to basket', 
          'buy now',
          'checkout',
          'shopping cart',
          'price list'
        ];
        
        // More precise shop detection - require multiple strong indicators
        let shopScore = 0;
        
        // Check text content for shop-related terms - these are strong indicators
        const pageText = document.body.innerText.toLowerCase();
        shopElements.forEach(term => {
          if (pageText.includes(term)) {
            shopScore += 2; // Strong indicators get 2 points
          }
        });
        
        // These are weaker indicators that might be present on non-shop sites
        const weakShopTerms = ['product', 'price', 'shop', 'store'];
        weakShopTerms.forEach(term => {
          if (pageText.includes(term)) {
            shopScore += 1; // Weak indicators get 1 point
          }
        });
        
        // Check for actual purchase functionality
        const purchaseIndicators = [
          'form[action*="cart"]', 
          'form[action*="checkout"]',
          'input[name*="quantity"]',
          'button[name*="cart"]',
          'button[name*="checkout"]',
          '.woocommerce',
          '.shopify',
          '.cart-contents',
          '.add-to-cart'
        ];
        
        // Strong evidence of e-commerce functionality
        purchaseIndicators.forEach(selector => {
          if (document.querySelectorAll(selector).length > 0) {
            shopScore += 3; // Very strong indicators get 3 points
          }
        });
        
        // A site is considered a shop if it scores at least 5 points
        const hasShopElements = shopScore >= 5;
        
        return {
          imageCount,
          hasShopElements,
          shopScore
        };
      });
      
      console.log(`Page analysis: ${pageAnalysis.imageCount} images, ${pageAnalysis.hasShopElements ? 'is a shop (score: ' + pageAnalysis.shopScore + ')' : 'is not a shop (score: ' + pageAnalysis.shopScore + ')'}`);
      
      // Determine if we should apply image optimization
      const shouldBlockImages = 
        // Only block if it's a shop with high confidence
        (isLikelyShop && pageAnalysis.shopScore >= 5) || 
        // Block if it has a lot of images
        pageAnalysis.imageCount > 100;
      
      // Close the analysis page and start fresh
      await page.close();
      
      // Create a new page for the actual screenshot
      const capturePage = await browser.newPage();
      
      // Set up cookie blocking
      await capturePage.setCookie();
      await capturePage.evaluateOnNewDocument(() => {
        // Override the navigator.cookieEnabled property
        Object.defineProperty(navigator, 'cookieEnabled', {
          get: () => false,
          configurable: true
        });
        
        // Block document.cookie
        Object.defineProperty(document, 'cookie', {
          get: () => '',
          set: () => '',
          configurable: true
        });
      });
      
      // Set up request interception
      await capturePage.setRequestInterception(true);
      capturePage.on('request', (request) => {
        const url = request.url().toLowerCase();
        const resourceType = request.resourceType();
        
        // Always block cookie-related content
        if (
          url.includes('cookie') || 
          url.includes('consent') || 
          url.includes('gdpr') ||
          (resourceType === 'script' && (url.includes('cookie') || url.includes('consent')))
        ) {
          request.abort();
        } 
        // Block ad-related content and trackers
        else if (
          url.includes('ads') || 
          url.includes('advert') || 
          url.includes('banner') ||
          url.includes('popup') || 
          url.includes('track') || 
          url.includes('analytics') ||
          url.includes('pixel') ||
          url.includes('campaign') ||
          url.includes('promo') ||
          url.includes('doubleclick') ||
          url.includes('google-analytics') ||
          url.includes('facebook') ||
          url.includes('marketing') ||
          url.includes('adsense') ||
          url.includes('adnxs') ||
          url.includes('criteo') ||
          url.includes('taboola') ||
          url.includes('outbrain') ||
          // Common ad domains
          /google.*\/ads/.test(url) ||
          /doubleclick\.net/.test(url) ||
          /adservice\.google/.test(url) ||
          /analytics\.google\.com/.test(url) ||
          /facebook\.com\/tr/.test(url) ||
          /amazon-adsystem\.com/.test(url) ||
          /adform\.net/.test(url) ||
          /mathtag\.com/.test(url) ||
          /rubiconproject\.com/.test(url)
        ) {
          request.abort();
        } 
        // Block images only if it's a shop or has too many images
        else if (shouldBlockImages && resourceType === 'image') {
          // Allow critical images like logos
          if (url.includes('logo') || url.includes('header') || url.includes('banner')) {
            request.continue();
          } else {
            request.abort();
          }
        }
        // Block heavy resources like videos, large scripts, etc.
        else if (['media', 'websocket', 'texttrack'].includes(resourceType) ||
                (resourceType === 'script' && 
                  (url.includes('google-analytics') || 
                  url.includes('facebook') || 
                  url.includes('analytics') || 
                  url.includes('tracker') || 
                  url.includes('pixel') ||
                  url.includes('ads')))
        ) {
          request.abort();
        }
        else {
          request.continue();
        }
      });

      let targetUrl = url;

      // Handle translation if required
      if (targetLang) {
        console.log(`Translation requested for ${url} to language: ${targetLang}`);
        
        // Construct Google Translate URL with better parameters
        // Important: 'hl' is the UI language, 'sl' is source language, 'tl' is target language
        targetUrl = `https://translate.google.com/translate?hl=${targetLang}&sl=auto&tl=${targetLang}&u=${encodeURIComponent(url)}`;
        
        console.log(`Using Google Translate URL: ${targetUrl}`);
        
        // When loading Google Translate pages, wait longer and be more patient
        await capturePage.goto(targetUrl, { 
          waitUntil: ['domcontentloaded', 'networkidle2'],
          timeout: 60000 // 60 second timeout for translations
        }).catch(err => {
          console.log(`Warning: Google Translate navigation had an issue: ${err.message}`);
          console.log('Continuing with capture anyway...');
        });
        
        // Google Translate might need additional time to fully render
        console.log('Waiting for Google Translate to fully render...');
        await capturePage.waitForTimeout(5000);
        
        // Sometimes Google Translate shows a consent screen - try to accept it
        try {
          const consentButton = await capturePage.$('button[jsname="LgbsSe"]');
          if (consentButton) {
            console.log('Found Google consent button, clicking it...');
            await consentButton.click();
            await capturePage.waitForTimeout(2000);
          }
        } catch (e) {
          console.log('No consent button found or error clicking it:', e.message);
        }
        
        console.log('Translation page loaded, proceeding with screenshot...');
      } else {
        // Regular navigation for non-translated pages
        console.log(`Navigating to: ${targetUrl} ${shouldBlockImages ? '(blocking most images)' : ''}`);
        
        // Set appropriate timeout and options
        try {
          await capturePage.goto(targetUrl, { 
            waitUntil: ['domcontentloaded', 'networkidle2'],
            timeout: 30000 // 30 second timeout
          });
        } catch (navigationError) {
          console.log(`Navigation timed out for ${targetUrl}, continuing with capture anyway...`);
        }
      }

      // Auto-dismiss cookie popups
      await dismissCookiePopups(capturePage);
      
      // Dismiss ad popups and promotional overlays
      await dismissAdPopups(capturePage);

      // If we're not blocking images, wait a bit for them to load
      if (!shouldBlockImages) {
        console.log(`Waiting for images to load...`);
        await capturePage.evaluate(() => {
          return new Promise((resolve) => {
            // Wait up to 5 seconds for images
            setTimeout(resolve, 5000);
            
            // Check if all visible images are loaded
            const imageLoaded = () => {
              const images = Array.from(document.querySelectorAll('img'));
              const allLoaded = images.every(img => img.complete);
              if (allLoaded) resolve();
            };
            
            // Check periodically
            const interval = setInterval(() => {
              imageLoaded();
              // After 5 seconds, clear interval regardless
              setTimeout(() => clearInterval(interval), 5000);
            }, 500);
            
            // Also try with load event
            window.addEventListener('load', resolve);
          });
        });
      }

      // Scroll through the page to ensure all lazy-loaded content is loaded
      await capturePage.evaluate(async () => {
        await new Promise((resolve) => {
          let totalHeight = 0;
          const distance = 100;
          const timer = setInterval(() => {
            const scrollHeight = document.body.scrollHeight;
            window.scrollBy(0, distance);
            totalHeight += distance;

            if (totalHeight >= scrollHeight) {
              clearInterval(timer);
              window.scrollTo(0, 0);
              resolve();
            }
          }, 100);
        });
      });

      const filename = generateUniqueFilename(url);
      const screenshotPath = path.join(screenshotsDir, filename);
      console.log(`Taking screenshot: ${screenshotPath}`);
      await capturePage.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`Screenshot taken for: ${url}`);
      
      // Close page
      await capturePage.close();
      
      // Extract page type and domain information
      let pageType = 'Homepage';
      const urlObj = new URL(url);
      const domain = urlObj.hostname;
      
      if (urlObj.pathname && urlObj.pathname !== '/' && urlObj.pathname !== '') {
        // Get the last part of the path for a more descriptive name
        const pathParts = urlObj.pathname.split('/').filter(p => p);
        pageType = pathParts.length > 0 ? pathParts[pathParts.length - 1] : 'Section';
        
        // Capitalize and clean up the page type
        pageType = pageType
          .replace(/-/g, ' ')
          .replace(/\b\w/g, l => l.toUpperCase());
      }
      
      // Extract page content for WebSearchData
      const pageContent = await capturePage.evaluate(() => {
        const getTextContent = (selector) => {
          const el = document.querySelector(selector);
          return el ? el.textContent.trim() : '';
        };
        
        // Try to find relevant content sections
        const title = document.title;
        const description = getTextContent('meta[name="description"]') || 
                           getTextContent('.description') || 
                           getTextContent('#description');
        
        const products = Array.from(document.querySelectorAll('.product, [class*="product"], [id*="product"]'))
          .map(el => el.textContent.trim())
          .join('\n');
          
        const industry = getTextContent('[class*="industry"], [id*="industry"]') || '';
        
        // Extract content from main sections
        const mainContent = getTextContent('main') || 
                          getTextContent('#main') || 
                          getTextContent('.main-content') || 
                          getTextContent('.content');
                          
        // Look for About Us or Profile sections
        const profile = getTextContent('[class*="about"], [id*="about"], .profile, #profile') || '';
        
        // Try to find process information
        const process = getTextContent('[class*="process"], [id*="process"], [class*="how-we"], [id*="how-we"]') || '';
        
        // Identify potential group affiliation
        const group = getTextContent('[class*="group"], [id*="group"], [class*="parent"], [id*="parent"]') || '';
        
        return {
          title,
          description,
          products,
          industry,
          mainContent,
          profile,
          process,
          group
        };
      });
      
      // Create screenshot object
      const screenshot = {
        originalUrl: url,
        filename: filename,
        screenshotUrl: `/screenshots/${filename}`,
        timestamp: new Date().toISOString(),
        domain: domain,
        path: urlObj.pathname || '/',
        pageType: pageType,
        pageContent: pageContent
      };
      
      // Add to database
      screenshotDatabase.addScreenshot(screenshot);
      
      // If userId and benchmarkId are provided, send to Django backend
      if (userId && benchmarkId) {
        try {
          await sendScreenshotToDjango(screenshot, userId, benchmarkId);
        } catch (error) {
          console.error(`Failed to send screenshot to Django: ${error.message}`);
        }
      }
      
      return screenshot;
    } catch (err) {
      console.error(`Failed to capture screenshot for ${url}: ${err.message}`);
      return null;
    } finally {
      await releaseBrowser(browser);
    }
  };

  // Helper function to dismiss cookie popups
  const dismissCookiePopups = async (page) => {
    try {
      console.log('Attempting to dismiss cookie popups...');
      
      // List of common cookie consent selectors
      const cookieSelectors = [
        // Accept buttons
        'button[id*="accept"i]',
        'button[class*="accept"i]',
        'a[id*="accept"i]',
        'a[class*="accept"i]',
        'button[id*="cookie"i]',
        'button[class*="cookie"i]',
        '.cookie-accept',
        '.accept-cookies',
        '[aria-label*="accept cookies"i]',
        '[aria-label*="accept all"i]',
        '[data-testid*="accept"i]',
        '[data-testid*="cookie"i]',
        // Common specific IDs and classes
        '#onetrust-accept-btn-handler',
        '.CookieConsent__button',
        '#accept-cookie-policy',
        '.cc-accept',
        '.gdpr-banner-button',
        '.js-accept-cookies',
        '.js-cookie-accept',
        // Submit type inputs
        'input[type="submit"][value*="accept"i]',
        'input[type="submit"][value*="agree"i]',
        // Dialog dismiss buttons
        'button[id*="close"i]',
        'button[class*="close"i]',
        '.cookie-banner-close',
        '.cookie-dialog-close',
        // Buttons with text containing "accept" or "agree"
        'button:contains("Accept")',
        'button:contains("Agree")',
        'button:contains("I agree")',
        'button:contains("Accept all")',
        'button:contains("Allow")',
        // Newer cookie consent approaches
        '.fc-button.fc-cta-consent',
        '.fc-button.fc-primary',
        '.fc-confirm-choices',
        '.cmplz-accept',
        // Buttons with data attributes
        '[data-cookiebanner="accept_button"]',
        // Very specific selectors for common providers
        '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
        '.js-cookieAcceptAll',
        '[data-gdpr-accept]',
        '.consent-modal-button[data-action="accept"]',
        '.consent-button[data-action="accept_all"]'
      ];

      // Try each selector and click if found in main document
      for (const selector of cookieSelectors) {
        try {
          const elements = await page.$$(selector);
          if (elements.length > 0) {
            await elements[0].click();
            console.log(`Dismissed cookie popup using selector: ${selector}`);
            // Wait a bit after clicking
            await page.waitForTimeout(300);
          }
        } catch (err) {
          // Ignore errors for individual selectors
        }
      }

      // Try to handle iframes - first get all iframes
      try {
        const frames = page.frames();
        console.log(`Found ${frames.length} frames on the page`);
        
        // For each frame, try to dismiss cookie popups
        for (const frame of frames) {
          if (frame !== page.mainFrame()) {
            try {
              console.log(`Checking frame: ${frame.url()}`);
              
              // Skip frames from different origins as they'll throw security errors
              if (!frame.url() || frame.url().startsWith('about:') || frame.url() === 'about:blank') {
                console.log('Skipping empty/about:blank frame');
                continue;
              }
              
              // Try each selector in this frame
              for (const selector of cookieSelectors) {
                try {
                  const frameElements = await frame.$$(selector);
                  if (frameElements.length > 0) {
                    await frameElements[0].click();
                    console.log(`Dismissed cookie popup in iframe using selector: ${selector}`);
                    await page.waitForTimeout(300);
                    break; // Break after first successful click in this frame
                  }
                } catch (frameErr) {
                  // Ignore individual selector errors in frames
                }
              }
              
              // Also try clicking buttons with text containing 'accept' or 'agree'
              await frame.evaluate(() => {
                try {
                  // Get all buttons
                  const buttons = Array.from(document.querySelectorAll('button'));
                  // Filter buttons with text containing 'accept' or 'agree' or 'allow'
                  const acceptButtons = buttons.filter(button => {
                    const text = button.textContent.toLowerCase();
                    return text.includes('accept') || text.includes('agree') || text.includes('allow') || text.includes('got it');
                  });
                  
                  // Click the first matching button if any
                  if (acceptButtons.length > 0) {
                    acceptButtons[0].click();
                    return true;
                  }
                  return false;
                } catch (e) {
                  return false;
                }
              }).then(clicked => {
                if (clicked) console.log('Clicked text-based accept button in iframe');
              }).catch(() => {
                // Ignore errors in frame evaluation
              });
            } catch (frameErr) {
              console.log(`Error handling iframe: ${frameErr.message}`);
            }
          }
        }
      } catch (framesErr) {
        console.log(`Error getting frames: ${framesErr.message}`);
      }

      // Advanced approach: use JS evaluation to find and click buttons by text content
      await page.evaluate(() => {
        const textPhrases = [
          'accept all', 'accept cookies', 'i agree', 'agree', 'accept', 
          'allow all', 'allow cookies', 'allow', 'consent', 'got it', 'okay'
        ];
        
        // Function to check if element text contains any of our phrases
        const hasAcceptText = (element) => {
          if (!element || !element.textContent) return false;
          const text = element.textContent.toLowerCase().trim();
          return textPhrases.some(phrase => text.includes(phrase));
        };
        
        // Get all clickable elements
        const clickables = [
          ...document.querySelectorAll('button'),
          ...document.querySelectorAll('a[role="button"]'),
          ...document.querySelectorAll('[role="button"]'),
          ...document.querySelectorAll('input[type="submit"]'),
          ...document.querySelectorAll('input[type="button"]')
        ];
        
        // Filter and sort by most likely to be accept buttons
        const acceptButtons = clickables
          .filter(el => hasAcceptText(el))
          .sort((a, b) => {
            // Prioritize buttons with exact text matches
            const aText = a.textContent.toLowerCase().trim();
            const bText = b.textContent.toLowerCase().trim();
            
            // Primary sort: exact "accept all cookies" type matches
            const aExact = aText === 'accept all cookies' || aText === 'accept all';
            const bExact = bText === 'accept all cookies' || bText === 'accept all';
            if (aExact && !bExact) return -1;
            if (!aExact && bExact) return 1;
            
            // Secondary sort: shorter text is likely more specific
            return aText.length - bText.length;
          });
        
        // Click the most promising button
        if (acceptButtons.length > 0) {
          acceptButtons[0].click();
          return true;
        }
        
        return false;
      }).then(clicked => {
        if (clicked) console.log('Clicked button with accept text');
      }).catch(err => {
        console.log(`Error in text-based button search: ${err.message}`);
      });

      // Remove cookie banners directly from DOM as a fallback
      await page.evaluate(() => {
        const possibleBanners = [
          // Common banner class names
          '.cookie-banner', '.cookie-popup', '.cookie-notification', '.cookie-consent',
          '.cookie-dialog', '.cookie-message', '#cookie-banner', '#cookie-popup',
          '#cookie-notification', '#cookie-consent', '#cookie-dialog',
          '[class*="cookie-banner"i]', '[class*="cookie-popup"i]', '[class*="cookie-consent"i]',
          '[id*="cookie-banner"i]', '[id*="cookie-popup"i]', '[id*="cookie-consent"i]',
          // GDPR related
          '.gdpr-banner', '#gdpr-banner', '[class*="gdpr"i][class*="banner"i]', 
          '[id*="gdpr"i][id*="banner"i]',
          // Privacy policy banners
          '.privacy-policy-banner', '#privacy-policy-banner', '[class*="privacy"i][class*="banner"i]',
          '[id*="privacy"i][id*="banner"i]',
          // Common cookie banner implementations
          '#onetrust-banner-sdk', '#onetrust-consent-sdk',
          '.truste_box_overlay', '.truste_overlay',
          '.cc-window', '.cc-banner',
          '.js-consent-banner', '.js-cookie-banner',
          '#cookiebanner', '.cookie-law-info-bar',
          '.cookielaw', '.cookiebar',
          // Fixed position elements that might be cookie banners
          'div[style*="position:fixed"][style*="bottom:0"]',
          'div[style*="position: fixed"][style*="bottom: 0"]',
          'div[style*="position:fixed"][style*="top:0"]',
          'div[style*="position: fixed"][style*="top: 0"]'
        ];

        possibleBanners.forEach(selector => {
          try {
          const elements = document.querySelectorAll(selector);
          elements.forEach(el => {
            if (el && el.parentNode) {
                // Check if the element is likely a cookie banner by looking at its content
                const text = el.textContent.toLowerCase();
                if (text.includes('cookie') || text.includes('gdpr') || 
                    text.includes('privacy') || text.includes('consent')) {
              el.parentNode.removeChild(el);
                }
              }
            });
          } catch (e) {
            // Ignore individual selector errors
          }
        });
      });
      
      // Final attempt: Try setting cookies directly to avoid banners in the future
      await page.evaluate(() => {
        // Set common cookie consent cookies with long expiration
        const cookieConsents = [
          'euconsent=1',
          'CookieConsent=true',
          'cookieconsent_status=dismiss',
          'cookie_notice_accepted=true',
          'cookies_accepted=1',
          'cookies_policy=accepted'
        ];
        
        const expiryDate = new Date();
        expiryDate.setFullYear(expiryDate.getFullYear() + 1);
        
        cookieConsents.forEach(cookie => {
          document.cookie = `${cookie}; expires=${expiryDate.toUTCString()}; path=/`;
        });
      });
    } catch (error) {
      console.log(`Error while dismissing cookie popups: ${error.message}`);
    }
  };

  // New function to send screenshot data to Django
  const sendScreenshotToDjango = async (screenshot, userId, benchmarkId) => {
    const DJANGO_API_URL = 'http://localhost:8000/api'; // Change to match your Django server URL
    
    try {
      // If userId is missing, use default (1)
      userId = userId || 1;
      
      console.log(`Sending screenshot data to Django for user ${userId} and benchmark ${benchmarkId}`);
      
      // First, check if there's an existing CompanyData entry with this domain
      const domainParts = screenshot.domain.split('.');
      const companyName = domainParts.length > 1 ? domainParts[domainParts.length - 2] : screenshot.domain;
      
      // Prepare data for CompanyData model
      const companyData = {
        user: userId,
        benchmark: benchmarkId,
        company_name: companyName.charAt(0).toUpperCase() + companyName.slice(1), // Capitalize first letter
        website: screenshot.originalUrl,
        status: 'Processed'
      };
      
      // Send POST request to create/update CompanyData
      const companyResponse = await fetch(`${DJANGO_API_URL}/company-data/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(companyData)
      });
      
      if (!companyResponse.ok) {
        throw new Error(`Failed to create CompanyData: ${companyResponse.statusText}`);
      }
      
      const company = await companyResponse.json();
      console.log(`Created/updated CompanyData with ID: ${company.id}`);
      
      // Now create WebSearchData with the page content
      const webSearchData = {
        company_data: company.id,
        description: screenshot.pageContent.description || screenshot.pageContent.mainContent.substring(0, 500),
        industry: screenshot.pageContent.industry,
        products: screenshot.pageContent.products,
        process: screenshot.pageContent.process,
        profile: screenshot.pageContent.profile,
        group: screenshot.pageContent.group
      };
      
      // Send POST request to create WebSearchData
      const webSearchResponse = await fetch(`${DJANGO_API_URL}/web-search-data/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(webSearchData)
      });
      
      if (!webSearchResponse.ok) {
        throw new Error(`Failed to create WebSearchData: ${webSearchResponse.statusText}`);
      }
      
      console.log(`Successfully sent data to Django for ${screenshot.domain}`);
      return true;
    } catch (error) {
      console.error(`Error sending data to Django: ${error.message}`);
      throw error;
    }
  };

  // Helper function to dismiss ad popups and overlays
  const dismissAdPopups = async (page) => {
    try {
      console.log('Attempting to dismiss ad popups and promotional overlays...');
      
      // Aggressive approach - find ALL "X" buttons and close icons first
      await page.evaluate(() => {
        console.log('Searching for close buttons using aggressive approach...');
        // Get any element that looks like an X button or close button
        // This runs in the browser context so we can use DOM directly
        
        // Function to check if an element is visible
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && 
                 style.visibility !== 'hidden' && 
                 style.opacity !== '0' &&
                 el.offsetWidth > 0 &&
                 el.offsetHeight > 0;
        };
        
        // Function to check if element is likely a close button
        const isCloseButton = (el) => {
          if (!el) return false;
          
          // Check text content
          const text = el.textContent.trim();
          if (text === '×' || text === 'X' || text === '✕' || text === '✖' || text === '⨯') return true;
          
          // Check for close-related classes
          const classNames = el.className || '';
          const id = el.id || '';
          if (/close|dismiss|cancel|shut/i.test(classNames) || /close|dismiss|cancel|shut/i.test(id)) return true;
          
          // Check for small clickable elements in corners
          const rect = el.getBoundingClientRect();
          if (rect.width < 40 && rect.height < 40) {
            const isTopRight = rect.top < 100 && rect.right > window.innerWidth - 100;
            const isTopLeft = rect.top < 100 && rect.left < 100;
            if (isTopRight || isTopLeft) return true;
          }
          
          return false;
        };
        
        // 1. First look specifically for X characters in small elements (these are almost always close buttons)
        const allElements = document.querySelectorAll('*');
        const closeElements = Array.from(allElements).filter(el => {
          if (!isVisible(el)) return false;
          
          // Check for exact "X" or "×" text content
          if (el.textContent.trim() === 'X' || 
              el.textContent.trim() === '×' || 
              el.textContent.trim() === '✕' || 
              el.textContent.trim() === '✖' || 
              el.textContent.trim() === '⨯') {
            const rect = el.getBoundingClientRect();
            // Small elements with X are almost certainly close buttons
            return rect.width < 40 && rect.height < 40;
          }
          return false;
        });
        
        // 2. Also find elements that are likely close buttons based on classes and position
        const potentialCloseButtons = Array.from(allElements).filter(el => 
          isVisible(el) && isCloseButton(el) && !closeElements.includes(el)
        );
        
        // Combine and sort by position (top corner buttons first)
        const allCloseButtons = [...closeElements, ...potentialCloseButtons]
          .sort((a, b) => {
            const aRect = a.getBoundingClientRect();
            const bRect = b.getBoundingClientRect();
            // Prioritize top-right corner positions (most common for close buttons)
            const aScore = (aRect.top < 100 ? 100 : 0) + (aRect.right > window.innerWidth - 100 ? 50 : 0);
            const bScore = (bRect.top < 100 ? 100 : 0) + (bRect.right > window.innerWidth - 100 ? 50 : 0);
            return bScore - aScore;
          });
        
        console.log(`Found ${allCloseButtons.length} potential close buttons`);
        
        // Click the best candidates
        if (allCloseButtons.length > 0) {
          // Focus on the top 3 most likely buttons
          const buttonsTryToClick = allCloseButtons.slice(0, 3);
          buttonsTryToClick.forEach(btn => {
            try {
              console.log('Clicking on likely close button:', btn.outerHTML);
              btn.click();
            } catch (e) {
              console.log('Error clicking button:', e);
            }
          });
          return true;
        }
        
        return false;
      });
      
      // Wait a short time for any animations from the clicks
      await page.waitForTimeout(500);
      
      // Common selectors for ad popups and promotional overlays
      const adSelectors = [
        // Close buttons and icons (more specific)
        'button.close', '.btn-close', '.icon-close', '.modal-close', '.popup-close', '.closeButton', '.close-button',
        '[aria-label="Close"]', '[aria-label="close"]', '[title="Close"]', '[title="close"]',
        'a.close', 'span.close', 'i.close', 'div.close',
        // X-specific selectors
        'button:has(span:contains("×"))', 'span:contains("×")', 'div:contains("×")',
        // Generic close patterns
        '[class*="close"]', '[id*="close"]', '[class*="dismiss"]', '[id*="dismiss"]',
        // Common ad and promo popup containers
        '.popup', '.modal', '.overlay', '.lightbox', '.modal-dialog',
        '.ad-container', '.promo-popup', '.newsletter-popup', '.offer-overlay',
        // Specific promotional content
        '[class*="newsletter"]', '[id*="newsletter"]',
        '[class*="concurs"]', '[id*="concurs"]',
        '[class*="promo"]', '[id*="promo"]',
        '[class*="popup"]', '[id*="popup"]'
      ];
      
      // Try each selector and click if found
      for (const selector of adSelectors) {
        try {
          const elements = await page.$$(selector);
          if (elements.length > 0) {
            await elements[0].click().catch(() => {});
            console.log(`Clicked potential ad popup element using selector: ${selector}`);
            await page.waitForTimeout(300);
          }
        } catch (err) {
          // Ignore errors for individual selectors
        }
      }
      
      // Try the "click anywhere" approach for overlay dismissal
      // Some overlays close when you click anywhere on them
      await page.evaluate(() => {
        // Find large overlay elements
        const overlays = Array.from(document.querySelectorAll('div[class*="overlay"], div[class*="modal"], div[class*="popup"]'))
          .filter(el => {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            
            const rect = el.getBoundingClientRect();
            // Look for large elements that cover most of the screen
            return rect.width > window.innerWidth * 0.5 && rect.height > window.innerHeight * 0.5;
          });
        
        // Click in the center of each overlay
        overlays.forEach(overlay => {
          try {
            const centerX = overlay.offsetWidth / 2;
            const centerY = overlay.offsetHeight / 2;
            
            // Create and dispatch a click event
            const clickEvent = new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: centerX,
              clientY: centerY
            });
            
            overlay.dispatchEvent(clickEvent);
          } catch (e) {
            // Ignore click errors
          }
        });
      });
      
      // Last resort: use the browser's Escape key to dismiss modals
      await page.keyboard.press('Escape').catch(() => {});
      
      // Remove overlays from DOM directly as a final attempt
      await page.evaluate(() => {
        // Find elements that look like overlays
        const overlaySelectors = [
          // Visual characteristics of overlays
          'div[style*="position:fixed"]',
          'div[style*="position: fixed"]',
          'div[style*="z-index:"]',
          // Common overlay patterns
          '[class*="popup"]', '[id*="popup"]',
          '[class*="modal"]', '[id*="modal"]',
          '[class*="overlay"]', '[id*="overlay"]',
          '[class*="lightbox"]', '[id*="lightbox"]',
          // Promotional content
          '[class*="promo"]', '[id*="promo"]',
          '[class*="concurs"]', '[id*="concurs"]'
        ];
        
        // Try to remove overlay elements
        overlaySelectors.forEach(selector => {
          try {
            const elements = document.querySelectorAll(selector);
            elements.forEach(el => {
              // Additional checks to ensure it's likely an overlay
              const style = window.getComputedStyle(el);
              const isOverlay = style.position === 'fixed' || 
                              style.position === 'absolute' ||
                              parseInt(style.zIndex || 0) > 100;
                              
              // Check size - overlays are usually large
              const rect = el.getBoundingClientRect();
              const isLarge = rect.width > window.innerWidth * 0.5 || 
                             rect.height > window.innerHeight * 0.5;
              
              // Remove if it matches overlay characteristics
              if ((isOverlay || isLarge) && el.parentNode) {
                console.log('Removing overlay element:', el.outerHTML.substring(0, 100) + '...');
                el.parentNode.removeChild(el);
              }
            });
          } catch (e) {
            // Ignore removal errors
          }
        });
        
        // Remove backdrop/overlay elements
        const backdropElements = document.querySelectorAll('.modal-backdrop, .overlay-backdrop, div[class*="backdrop"]');
        backdropElements.forEach(el => {
          if (el && el.parentNode) {
            el.parentNode.removeChild(el);
          }
        });
        
        // Fix scroll locks
        document.body.style.overflow = 'auto';
        document.body.style.position = 'static';
        document.documentElement.style.overflow = 'auto';
        document.body.classList.remove('modal-open', 'no-scroll', 'overflow-hidden');
      });
      
    } catch (error) {
      console.log(`Error while dismissing ad popups: ${error.message}`);
    }
  };

  // Modified endpoint to accept user and benchmark IDs
  app.post('/api/screenshots', async (req, res) => {
    console.log(`Worker ${process.pid} received POST request to /api/screenshots`);
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    console.log('Raw request body:', req.body);
    console.log('Language value explicitly:', req.body.language);
    
    const { urls, userId = 1, benchmarkId, language } = req.body;  // Just use language parameter

    // Add additional headers to log
    console.log('Request headers:', req.headers);

    // Retrieve and normalize the 'translate-to-romanian' header value
    const translateHeaderRaw = req.headers['translate-to-romanian'] || '';
    const translateHeader = translateHeaderRaw.trim().toLowerCase();

    console.log('translate-to-romanian header:', translateHeader);
    console.log(`User ID: ${userId} (${userId ? 'provided' : 'using default'}), Benchmark ID: ${benchmarkId}`);
    console.log(`Language from body: ${language || 'not specified'}`);

    let targetLang = null;
    let sourceLang = 'auto'; // Always use auto for source language
    
    // Simple language handling - just support direct translation to target language
    if (language) {
      if (language.toLowerCase() === 'ro') {
        // Translate to Romanian
        targetLang = 'ro';
        console.log('Will translate content to Romanian');
      } else if (language.toLowerCase() === 'en') {
        // Translate to English
        targetLang = 'en';
        console.log('Will translate content to English');
      } else {
        return res.status(400).send({ 
          error: 'Invalid language value', 
          message: 'Use "en" for English translation or "ro" for Romanian translation'
        });
      }
    } 
    // If no language in body, fall back to header-based logic
    else if (translateHeader === 'true') {
      targetLang = 'ro'; // Translate to Romanian
      console.log('Using Romanian translation based on header');
    } else if (translateHeader === 'false') {
      targetLang = 'en'; // Translate to English
      console.log('Using English translation based on header');
    } else if (translateHeader) {
      // If the header is set but not 'true' or 'false', return an error
      return res.status(400).send({ error: 'Invalid translate-to-romanian header value. Use "true" or "false".' });
    }

    // Check if URLs is a single string and split it
    let urlList = urls;
    if (typeof urls === 'string') {
      urlList = urls.split(',').map(url => url.trim());
    }

    console.log('Processing URL list:', urlList);

    if (!urlList || !Array.isArray(urlList) || urlList.length === 0) {
      console.log('Invalid input: URL list is empty or invalid');
      return res.status(400).send({ error: 'Invalid input: URL list is empty or invalid' });
    }

    // Validate URLs and remove invalid ones
    const validUrls = urlList.filter(url => {
      try {
        new URL(url);
        return true;
      } catch (error) {
        console.error(`Invalid URL skipped: ${url}, Error: ${error.message}`);
        return false;
      }
    });

    console.log('Valid URLs:', validUrls);

    if (validUrls.length === 0) {
      console.log('No valid URLs provided');
      return res.status(400).send({ error: 'No valid URLs provided' });
    }

    const screenshotsDir = path.join(__dirname, 'screenshots');
    if (!fs.existsSync(screenshotsDir)) {
      console.log('Creating screenshots directory...');
      fs.mkdirSync(screenshotsDir);
    }

    try {
      // Process URLs in parallel with Promise.all
      const screenshotPromises = validUrls.map(url => {
        console.log(`Processing URL: ${url}, targetLang: ${targetLang}, sourceLang: ${sourceLang}`);
        return processUrl(url, targetLang, screenshotsDir, userId, benchmarkId, sourceLang);
      });
      
      // Wait for all screenshots to be taken
      const results = await Promise.all(screenshotPromises);
      
      // Filter out null results (failed screenshots)
      const screenshots = results.filter(result => result !== null);

      console.log(`Worker ${process.pid} completed processing ${screenshots.length} screenshots`);

      // Get unique domain information from the screenshots
      const domains = [];
      const domainSet = new Set();
      
      screenshots.forEach(screenshot => {
        if (!domainSet.has(screenshot.domain)) {
          domainSet.add(screenshot.domain);
          domains.push({
            domain: screenshot.domain,
            url: `https://${screenshot.domain}`,
            originalUrl: screenshot.originalUrl
          });
        }
      });

      // Send success response with screenshot info and domain info
      res.status(200).send({
        message: 'Screenshots taken successfully',
        screenshots: screenshots,
        domains: domains
      });
    } catch (error) {
      console.error('Error:', error);
      res.status(500).send({ error: 'An error occurred while taking screenshots' });
    }
  });

  // New endpoint for base64 screenshots for direct database storage
  app.post('/api/screenshots-base64', async (req, res) => {
    console.log(`Worker ${process.pid} received POST request to /api/screenshots-base64`);
    console.log('Request body:', req.body);
    
    const { urls, userId = 1, benchmarkId, language } = req.body;  // Extract language parameter here

    // Add additional headers to log
    console.log('Request headers:', req.headers);
    console.log(`User ID: ${userId} (${userId ? 'provided' : 'using default'}), Benchmark ID: ${benchmarkId}`);
    console.log(`Language setting: ${language || 'not specified'}`);

    // Set up translation if language is specified
    let targetLang = null;
    if (language) {
      if (language.toLowerCase() === 'ro') {
        // Translate to Romanian
        targetLang = 'ro';
        console.log('Will translate content to Romanian');
      } else if (language.toLowerCase() === 'en') {
        // Translate to English
        targetLang = 'en';
        console.log('Will translate content to English');
      } else {
        return res.status(400).send({ 
          error: 'Invalid language value', 
          message: 'Use "en" for English translation or "ro" for Romanian translation'
        });
      }
    }

    // Check if URLs is a single string and split it
    let urlList = urls;
    if (typeof urls === 'string') {
      urlList = urls.split(',').map(url => url.trim());
    }

    console.log('Processing URL list for base64:', urlList);

    if (!urlList || !Array.isArray(urlList) || urlList.length === 0) {
      console.log('Invalid input: URL list is empty or invalid');
      return res.status(400).send({ error: 'Invalid input: URL list is empty or invalid' });
    }

    // Validate URLs and remove invalid ones
    const validUrls = urlList.filter(url => {
      try {
        new URL(url);
        return true;
      } catch (error) {
        console.error(`Invalid URL skipped: ${url}, Error: ${error.message}`);
        return false;
      }
    });

    console.log('Valid URLs for base64 encoding:', validUrls);

    if (validUrls.length === 0) {
      console.log('No valid URLs provided');
      return res.status(400).send({ error: 'No valid URLs provided' });
    }

    try {
      const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      
      const screenshots = [];
      
      // Process each URL sequentially
      for (const url of validUrls) {
        try {
          console.log(`Taking base64 screenshot of: ${url}`);
          const page = await browser.newPage();
          
          // Configure page to block cookies
          await page.setCookie(); // Clear any existing cookies
          await page.evaluateOnNewDocument(() => {
            // Override the navigator.cookieEnabled property
            Object.defineProperty(navigator, 'cookieEnabled', {
              get: () => false,
              configurable: true
            });
            
            // Block document.cookie
            Object.defineProperty(document, 'cookie', {
              get: () => '',
              set: () => '',
              configurable: true
            });
          });
          
          // Set original URL
          let targetUrl = url;
          
          // Handle translation if required
          if (targetLang) {
            console.log(`Translation requested for ${url} to language: ${targetLang}`);
            
            // Construct Google Translate URL
            targetUrl = `https://translate.google.com/translate?hl=${targetLang}&sl=auto&tl=${targetLang}&u=${encodeURIComponent(url)}`;
            
            console.log(`Using Google Translate URL: ${targetUrl}`);
            
            // Go to translated URL with extended timeout
            await page.goto(targetUrl, { 
              waitUntil: ['domcontentloaded', 'networkidle2'],
              timeout: 60000 // 60 seconds for translations
            }).catch(err => {
              console.log(`Warning: Google Translate had an issue: ${err.message}`);
              console.log('Continuing with capture anyway...');
            });
            
            // Google Translate needs extra time to render
            console.log('Waiting for Google Translate to fully render...');
            await page.waitForTimeout(5000);
            
            // Handle Google consent screen if it appears
            try {
              const consentButton = await page.$('button[jsname="LgbsSe"]');
              if (consentButton) {
                console.log('Found Google consent button, clicking it...');
                await consentButton.click();
                await page.waitForTimeout(2000);
              }
            } catch (e) {
              console.log('No consent button found or error clicking it:', e.message);
            }
            
            console.log('Translation page loaded, proceeding with screenshot...');
          } else {
            // Go to original URL if no translation
            console.log(`Going to original URL: ${targetUrl}`);
            await page.goto(targetUrl, { 
              waitUntil: ['domcontentloaded', 'networkidle2'],
              timeout: 30000
            });
          }
          
          // Auto-dismiss cookie popups
          await dismissCookiePopups(page);
          
          // Scroll through the page to ensure all content is loaded
          await page.evaluate(async () => {
            await new Promise((resolve) => {
              let totalHeight = 0;
              const distance = 100;
              const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;

                if (totalHeight >= scrollHeight) {
                  clearInterval(timer);
                  window.scrollTo(0, 0);
                  resolve();
                }
              }, 100);
            });
          });
          
          // Take screenshot as base64
          console.log('Capturing base64 screenshot...');
          const screenshotBuffer = await page.screenshot({ fullPage: true });
          const base64Screenshot = screenshotBuffer.toString('base64');
          
          // Extract domain information
          const urlObj = new URL(url);
          const domain = urlObj.hostname;
          
          // Extract content data for database storage
          const pageContent = await page.evaluate(() => {
            const getTextContent = (selector) => {
              const el = document.querySelector(selector);
              return el ? el.textContent.trim() : '';
            };
            
            // Try to find relevant content sections
            const title = document.title;
            const description = getTextContent('meta[name="description"]') || 
                               getTextContent('.description') || 
                               getTextContent('#description');
            
            const products = Array.from(document.querySelectorAll('.product, [class*="product"], [id*="product"]'))
              .map(el => el.textContent.trim())
              .join('\n');
              
            const industry = getTextContent('[class*="industry"], [id*="industry"]') || '';
            
            // Extract content from main sections
            const mainContent = getTextContent('main') || 
                              getTextContent('#main') || 
                              getTextContent('.main-content') || 
                              getTextContent('.content');
                              
            // Look for About Us or Profile sections
            const profile = getTextContent('[class*="about"], [id*="about"], .profile, #profile') || '';
            
            // Try to find process information
            const process = getTextContent('[class*="process"], [id*="process"], [class*="how-we"], [id*="how-we"]') || '';
            
            // Identify potential group affiliation
            const group = getTextContent('[class*="group"], [id*="group"], [class*="parent"], [id*="parent"]') || '';
            
            return {
              title,
              description,
              products,
              industry,
              mainContent,
              profile,
              process,
              group
            };
          });
          
          // Add to results
          screenshots.push({
            url: url,
            domain: domain,
            timestamp: new Date().toISOString(),
            imageBase64: base64Screenshot,
            content: pageContent,
            userId: userId,
            benchmarkId: benchmarkId
          });
          
          console.log(`Successfully captured base64 screenshot for: ${url}`);
          await page.close();
        } catch (error) {
          console.error(`Error capturing base64 screenshot for ${url}:`, error);
          // Continue with other URLs even if one fails
        }
      }
      
      await browser.close();
      
      console.log(`Completed base64 screenshots for ${screenshots.length} URLs`);
      
      // Return base64 encoded screenshots
      res.status(200).send({
        success: true,
        message: `Captured ${screenshots.length} base64 screenshots`,
        screenshots: screenshots
      });
    } catch (error) {
      console.error('Error in base64 screenshot processing:', error);
      res.status(500).send({ 
        success: false, 
        error: 'An error occurred while taking screenshots',
        details: error.message
      });
    }
  });

  // ENDPOINT 2: Get screenshots by domain
  app.get('/api/screenshots/:domain', (req, res) => {
    let { domain } = req.params;
    
    if (!domain) {
      return res.status(400).send({ error: 'Domain parameter is required' });
    }

    // Normalize domain by removing protocol and trailing slashes
    domain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    
    // Try different domain variations
    const domainVariations = [
      domain,
      `www.${domain}`,
      domain.replace(/^www\./, '')
    ];

    // Search for screenshots with any of the domain variations
    let screenshots = [];
    domainVariations.forEach(variation => {
      const domainScreenshots = screenshotDatabase.getScreenshotsByDomain(variation);
      screenshots = [...screenshots, ...domainScreenshots];
    });
    
    // Sort by timestamp (newest first)
    screenshots.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    if (screenshots.length === 0) {
      // Check if there are any screenshots on disk
      const screenshotsDir = path.join(__dirname, 'screenshots');
      if (fs.existsSync(screenshotsDir)) {
        const files = fs.readdirSync(screenshotsDir)
          .filter(file => {
            // Check if filename contains any of the domain variations
            return file.endsWith('.png') && 
                   domainVariations.some(variation => file.includes(variation));
          });
          
        if (files.length > 0) {
          // Found screenshots on disk but not in memory database
          // Create entries for them
          files.forEach(file => {
            const stats = fs.statSync(path.join(screenshotsDir, file));
            const domainMatch = domainVariations.find(v => file.includes(v)) || domain;
            
            // Create a screenshot entry and add to database
            const screenshot = {
              originalUrl: `https://${domainMatch}`,
              filename: file,
              screenshotUrl: `/screenshots/${file}`,
              timestamp: stats.mtime.toISOString(),
              domain: domainMatch,
              path: '/',
              pageType: 'Unknown'
            };
            
            screenshotDatabase.addScreenshot(screenshot);
            screenshots.push(screenshot);
          });
          
          // Sort again after adding disk-found screenshots
          screenshots.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        }
      }
      
      // If still no screenshots found
      if (screenshots.length === 0) {
        return res.status(404).send({ 
          error: 'No screenshots found for this domain',
          message: `Tried looking for: ${domainVariations.join(', ')}`,
          suggestion: 'Try using the exact domain name or take a new screenshot first'
        });
      }
    }

    // Return list of screenshots
    return res.status(200).send({
      domain: domain,
      screenshots: screenshots
    });
  });

  // ENDPOINT 3: Get all domains with screenshots
  app.get('/api/domains', (req, res) => {
    const domains = screenshotDatabase.getAllDomains();
    
    // Sort domains alphabetically
    domains.sort((a, b) => a.name.localeCompare(b.name));
    
    res.status(200).send({
      domains: domains
    });
  });

  // Serve static files from the "screenshots" directory with proper headers
  app.use('/screenshots', express.static(path.join(__dirname, 'screenshots'), {
    setHeaders: (res, path) => {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Disposition', 'inline');
    }
  }));

  // Load existing screenshots into memory on startup
  const loadExistingScreenshots = () => {
    const screenshotsDir = path.join(__dirname, 'screenshots');
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir);
      return;
    }
    
    console.log('Loading existing screenshots into memory...');
    
    try {
      const files = fs.readdirSync(screenshotsDir)
        .filter(file => file.endsWith('.png'));
        
      files.forEach(file => {
        const stats = fs.statSync(path.join(screenshotsDir, file));
        
        // Extract domain from filename
        let domain = 'unknown';
        try {
          const match = file.match(/^screenshot-([^-]+)/);
          if (match && match[1]) {
            domain = match[1].replace(/_/g, '.');
          }
        } catch (err) {
          console.error(`Error parsing domain from filename ${file}: ${err.message}`);
        }
        
        // Create screenshot entry and add to database
        const screenshot = {
          originalUrl: `https://${domain}`,
          filename: file,
          screenshotUrl: `/screenshots/${file}`,
          timestamp: stats.mtime.toISOString(),
          domain: domain,
          path: '/',
          pageType: 'Unknown'
        };
        
        screenshotDatabase.addScreenshot(screenshot);
      });
      
      console.log(`Loaded ${files.length} screenshots into memory`);
    } catch (error) {
      console.error('Error loading existing screenshots:', error);
    }
  };
  
  // Load existing screenshots when server starts
  loadExistingScreenshots();

  app.listen(port, () => {
    console.log(`API listening at http://localhost:${port}`);
  });
}