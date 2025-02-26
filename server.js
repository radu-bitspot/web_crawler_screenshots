const puppeteer = require('puppeteer');
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const cluster = require('cluster');
const os = require('os');

// Determine number of CPU cores to use (leave one core free for OS operations)
const numCPUs = Math.max(1, os.cpus().length - 1);

// Browser pool configuration
const BROWSER_POOL_SIZE = 3; // Maximum number of concurrent browser instances
let browserPool = [];
let activeBrowsers = 0;

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
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }
    next();
  });

  // Helper function to parse filename and get path info
  const parseFilename = (filename) => {
    try {
      // Remove 'screenshot-' prefix and '.png' extension
      const withoutPrefix = filename.replace(/^screenshot-/, '');
      const withoutTimestamp = withoutPrefix.replace(/-\d{4}-\d{2}.*\.png$/, '');
      
      // Split remaining parts by underscore
      const parts = withoutTimestamp.split('_');
      const domain = parts[0];
      
      // Check if it's homepage (no additional parts) or a section
      const isHomepage = parts.length === 1;
      const section = isHomepage ? null : parts[1].replace('_html', '');
      
      return { domain, isHomepage, section };
    } catch (error) {
      console.error('Error parsing filename:', error);
      return { domain: 'unknown', isHomepage: true, section: null };
    }
  };

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
    return `screenshot-${sanitized}.png`;
  };

  // Configuration
  const config = {
    maxScreenshotsPerDomain: 5,        // Keep only latest N screenshots per domain
    maxStorageSize: 500 * 1024 * 1024, // 500MB max storage
    screenshotRetentionDays: 7         // Keep screenshots for 7 days
  };

  // Helper function to get directory size
  const getDirSize = (dirPath) => {
    let size = 0;
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stats = fs.statSync(filePath);
      if (stats.isFile()) {
        size += stats.size;
      }
    }
    return size;
  };

  // Helper function to clean up old screenshots
  const cleanupOldScreenshots = () => {
    const screenshotsDir = path.join(__dirname, 'screenshots');
    if (!fs.existsSync(screenshotsDir)) return;

    console.log('Starting screenshots cleanup...');
    
    try {
      const files = fs.readdirSync(screenshotsDir)
        .filter(file => file.endsWith('.png'))
        .map(file => ({
          filename: file,
          path: path.join(screenshotsDir, file),
          stats: fs.statSync(path.join(screenshotsDir, file))
        }))
        .sort((a, b) => b.stats.mtime.getTime() - a.stats.mtime.getTime());

      // Group screenshots by domain
      const domainGroups = {};
      for (const file of files) {
        const domain = file.filename.split('-')[1]; // Get domain from filename
        if (!domainGroups[domain]) {
          domainGroups[domain] = [];
        }
        domainGroups[domain].push(file);
      }

      // Keep only the most recent screenshots per domain
      for (const domain in domainGroups) {
        const domainFiles = domainGroups[domain];
        const filesToRemove = domainFiles.slice(config.maxScreenshotsPerDomain);
        
        for (const file of filesToRemove) {
          console.log(`Removing old file: ${file.filename}`);
          fs.unlinkSync(file.path);
        }
      }

      // Remove files older than retention period
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - config.screenshotRetentionDays);

      files.forEach(file => {
        if (file.stats.mtime.getTime() < cutoffDate.getTime()) {
          console.log(`Removing expired file: ${file.filename}`);
          fs.unlinkSync(file.path);
        }
      });

      // Check total storage size
      const totalSize = getDirSize(screenshotsDir);
      if (totalSize > config.maxStorageSize) {
        console.log('Storage limit exceeded, removing oldest files...');
        for (const file of files) {
          fs.unlinkSync(file.path);
          if (getDirSize(screenshotsDir) <= config.maxStorageSize) {
            break;
          }
        }
      }

      console.log('Cleanup completed');
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
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
  const processUrl = async (url, targetLang, screenshotsDir) => {
    const browser = await getBrowser();
    
    try {
      const page = await browser.newPage();
      let targetUrl = url;

      // Handle translation if required
      if (targetLang) {
        targetUrl = `https://translate.google.com/translate?hl=${targetLang}&sl=auto&tl=${targetLang}&u=${encodeURIComponent(url)}`;
        console.log(`Translated URL: ${targetUrl}`);
      }

      console.log(`Navigating to: ${targetUrl}`);
      // Wait for the page to load with a longer timeout
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
      
      // Additional waiting to ensure page is fully loaded
      console.log(`Waiting for page to be fully loaded...`);
      
      // Wait for any remaining network activity to complete
      await page.waitForNetworkIdle({ idleTime: 1000 }).catch(e => console.log('Network idle timeout, continuing anyway'));
      
      // Wait for any animations or delayed content to finish loading (2 seconds)
      await page.waitForTimeout(2000);
      
      // Ensure all images and other resources are loaded
      await page.evaluate(() => {
        return new Promise((resolve) => {
          if (document.readyState === 'complete') {
            return resolve();
          }
          window.addEventListener('load', resolve);
        });
      });
      
      const filename = generateUniqueFilename(url);
      const screenshotPath = path.join(screenshotsDir, filename);
      console.log(`Taking screenshot: ${screenshotPath}`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`Screenshot taken for: ${url}`);
      
      await page.close();
      
      return {
        originalUrl: url,
        filename: filename,
        screenshotUrl: `/screenshots/${filename}`,
        timestamp: new Date().toISOString(),
        domain: new URL(url).hostname
      };
    } catch (err) {
      console.error(`Failed to capture screenshot for ${url}: ${err.message}`);
      return null;
    } finally {
      await releaseBrowser(browser);
    }
  };

  // Run cleanup every hour
  setInterval(cleanupOldScreenshots, 60 * 60 * 1000);

  // Endpoint to take screenshots
  app.post('/screenshot', async (req, res) => {
    console.log(`Worker ${process.pid} received POST request to /screenshot`);
    console.log('Request body:', req.body);
    
    const { urls } = req.body;

    // Retrieve and normalize the 'translate-to-romanian' header value
    const translateHeaderRaw = req.headers['translate-to-romanian'] || '';
    const translateHeader = translateHeaderRaw.trim().toLowerCase();

    console.log('translate-to-romanian header:', translateHeader);

    let targetLang = null;
    if (translateHeader === 'true') {
      targetLang = 'ro'; // Translate to Romanian
    } else if (translateHeader === 'false') {
      targetLang = 'en'; // Translate to English
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
      // Process URLs in parallel with a concurrency limit
      const screenshotPromises = validUrls.map(url => 
        processUrl(url, targetLang, screenshotsDir)
      );
      
      // Wait for all screenshots to be taken
      const results = await Promise.all(screenshotPromises);
      
      // Filter out null results (failed screenshots)
      const screenshots = results.filter(result => result !== null);

      console.log(`Worker ${process.pid} completed processing ${screenshots.length} screenshots`);

      // Send success response with screenshot info
      res.status(200).send({
        message: 'Screenshots taken successfully',
        screenshots: screenshots
      });
    } catch (error) {
      console.error('Error:', error);
      res.status(500).send({ error: 'An error occurred while taking screenshots' });
    }
  });

  // GET endpoint to retrieve screenshots by domain
  app.get('/screenshot/:domain', (req, res) => {
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

    const screenshotsDir = path.join(__dirname, 'screenshots');
    
    try {
      // Get all PNG files in the screenshots directory for any domain variation
      const files = fs.readdirSync(screenshotsDir)
        .filter(file => {
          // Check if filename contains any of the domain variations
          return file.endsWith('.png') && 
                 domainVariations.some(variation => file.includes(variation));
        })
        .map(file => ({
          filename: file,
          url: `/screenshots/${file}`,
          path: path.join(screenshotsDir, file),
          stats: fs.statSync(path.join(screenshotsDir, file))
        }))
        .sort((a, b) => b.stats.mtime.getTime() - a.stats.mtime.getTime());

      if (files.length === 0) {
        // Return more helpful error message with domain variations tried
        return res.status(404).send({ 
          error: 'No screenshots found for this domain',
          message: `Tried looking for: ${domainVariations.join(', ')}`,
          suggestion: 'Try using the exact domain: www.geima.it'
        });
      }

      // Return list of screenshots
      return res.status(200).send({
        domain: domain,
        screenshots: files.map(file => ({
          filename: file.filename,
          url: file.url,
          timestamp: file.stats.mtime
        }))
      });
    } catch (error) {
      console.error(`Error retrieving screenshots: ${error}`);
      res.status(500).send({ error: 'Internal server error' });
    }
  });

  // Endpoint to list all domains with screenshots
  app.get('/domains', (req, res) => {
    const screenshotsDir = path.join(__dirname, 'screenshots');
    
    try {
      if (!fs.existsSync(screenshotsDir)) {
        return res.json({ domains: [] });
      }

      const files = fs.readdirSync(screenshotsDir)
        .filter(file => file.endsWith('.png'));

      // Extract unique domains from filenames using parseFilename helper
      const domains = [...new Set(files.map(file => {
        // Use the parseFilename helper function to correctly extract domain
        const { domain } = parseFilename(file);
        return domain;
      }))];

      res.json({ domains });
    } catch (error) {
      console.error('Error getting domains:', error);
      res.status(500).json({ error: 'Failed to get domains' });
    }
  });

  // Endpoint to download all screenshots as ZIP
  app.get('/download-all', (req, res) => {
    const screenshotsDir = path.join(__dirname, 'screenshots');
    
    try {
      if (!fs.existsSync(screenshotsDir)) {
        return res.status(404).json({ error: 'No screenshots found' });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const zipFilename = `screenshots-${timestamp}.zip`;
      res.attachment(zipFilename);
      
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.pipe(res);

      const files = fs.readdirSync(screenshotsDir)
        .filter(file => file.endsWith('.png'));

      // Process each file and add it to the archive
      files.forEach(file => {
        const filePath = path.join(screenshotsDir, file);
        const { domain, isHomepage, section } = parseFilename(file);
        
        let zipPath;
        if (isHomepage) {
          zipPath = `${domain}/homepage.png`;
        } else {
          zipPath = `${domain}/${section}/page.png`;
        }

        archive.file(filePath, { name: zipPath });
      });

      archive.finalize();
    } catch (error) {
      console.error('Error creating ZIP archive:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create ZIP archive' });
      }
    }
  });

  // Serve static files from the "screenshots" directory with proper headers
  app.use('/screenshots', express.static(path.join(__dirname, 'screenshots'), {
    setHeaders: (res, path) => {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Disposition', 'inline');
    }
  }));

  app.listen(port, () => {
    console.log(`API listening at http://localhost:${port}`);
  });
}
