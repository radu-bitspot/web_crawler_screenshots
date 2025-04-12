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

  // Helper function to parse filename and get path info (revised)
  const parseFilename = (filename) => {
    try {
      // Expected format: screenshot-${domain}[__${section}]-${timestamp}.png
      // Example: screenshot-example.com__section-name-2023-10-27T10-30-00-000Z.png
      // Example: screenshot-example.com-2023-10-27T10-30-00-000Z.png

      // Remove prefix and suffix
      const base = filename.replace(/^screenshot-/, '').replace(/\.png$/, '');

      // Find the last hyphen sequence that looks like an ISO timestamp
      const timestampMatch = base.match(/(.*)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/);

      if (!timestampMatch) {
        // Fallback if no timestamp is found (e.g., old files or different format)
        console.warn(`Could not parse standard timestamp from filename: ${filename}. Attempting fallback parsing.`);
        // Assume content is split by '__' if present, otherwise it's just domain
        const parts = base.split('__');
        const domain = parts[0];
        const section = parts.length > 1 ? parts.slice(1).join('__') : null;
        // Return best guess, domain might be inaccurate if it contained '__'
        return { domain: domain || 'unknown', isHomepage: !section, section: section };
      }

      const contentPart = timestampMatch[1]; // Part before the timestamp: domain or domain__section
      const timestamp = timestampMatch[2]; // The timestamp string

      // Split the content part by double underscore to separate domain and section
      const parts = contentPart.split('__');
      const domain = parts[0]; // Should be the full domain, e.g., 'example.com' or 'sub.example.co.uk'
      const section = parts.length > 1 ? parts.slice(1).join('__') : null; // Section part, if present

      return { domain, isHomepage: !section, section };

    } catch (error) {
      console.error('Error parsing filename:', error, filename);
      // Return default structure on error
      return { domain: 'unknown', isHomepage: true, section: null };
    }
  };

  // Helper function to sanitize filenames (revised)
  const sanitizeFilename = (url) => {
    try {
      const { hostname, pathname } = new URL(url);
      // Remove www. prefix from hostname
      const cleanHostname = hostname.replace(/^www\./i, '');
      // Sanitize hostname: allow letters, numbers, hyphens, dots
      // Replace any other characters with underscore
      const sanitizedHostname = cleanHostname.replace(/[^a-z0-9.-]/gi, '_').replace(/__+/g, '_'); // Avoid double underscore

      // Get the section from pathname (remove leading and trailing slashes)
      const section = pathname.replace(/^\/|\/$/g, '');
      // Sanitize section: allow letters, numbers, hyphens
      const sanitizedSection = section.replace(/[^a-z0-9-]/gi, '_').replace(/__+/g, '_'); // Avoid double underscore

      // Create a base filename part
      if (!sanitizedSection || sanitizedSection === '') {
        // This is homepage
        return sanitizedHostname; // Return just the sanitized hostname
      } else {
        // This is a section page, use double underscore as separator
        return `${sanitizedHostname}__${sanitizedSection}`;
      }
    } catch (error) {
      console.error(`Invalid URL: ${url}`);
      return 'invalid_url';
    }
  };

  // Helper function to generate unique filename (revised: adds timestamp)
  const generateUniqueFilename = (url) => {
    const sanitizedBase = sanitizeFilename(url);
    if (sanitizedBase === 'invalid_url') {
      // Add timestamp to invalid URLs too for uniqueness
      return `screenshot-invalid-url-${Date.now()}.png`;
    }
    // Add timestamp separated by a single hyphen to ensure uniqueness and help with sorting/cleanup
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `screenshot-${sanitizedBase}-${timestamp}.png`;
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

  // Helper function to clean up old screenshots (revised)
  const cleanupOldScreenshots = () => {
    const screenshotsDir = path.join(__dirname, 'screenshots');
    if (!fs.existsSync(screenshotsDir)) return;

    console.log('Starting screenshots cleanup...');

    try {
      // Read all files and parse info using the new parser
      const allFiles = fs.readdirSync(screenshotsDir)
        .filter(file => file.endsWith('.png'))
        .map(file => {
          const filePath = path.join(screenshotsDir, file);
          const fileInfo = parseFilename(file); // Use the improved parser
          try {
            const stats = fs.statSync(filePath);
            return {
              filename: file,
              domain: fileInfo.domain, // Get domain from parser
              path: filePath,
              stats: stats
            };
          } catch (statError) {
              console.error(`Could not get stats for file ${filePath}: ${statError.message}`);
              return null; // Indicate failure to get stats
          }
        })
        .filter(file => file !== null && file.domain !== 'unknown') // Filter out stat errors and unparseable files
        .sort((a, b) => b.stats.mtime.getTime() - a.stats.mtime.getTime()); // Newest first

      // Group screenshots by the parsed domain
      const domainGroups = {};
      for (const file of allFiles) {
        if (!domainGroups[file.domain]) {
          domainGroups[file.domain] = [];
        }
        domainGroups[file.domain].push(file);
      }

      const filesToRemove = new Set();

      // 1. Identify files exceeding the max count per domain
      for (const domain in domainGroups) {
        const domainFiles = domainGroups[domain]; // Already sorted newest first
        const filesExceedingLimit = domainFiles.slice(config.maxScreenshotsPerDomain);
        filesExceedingLimit.forEach(f => {
          console.log(`Marking for removal (exceeds max ${config.maxScreenshotsPerDomain} for ${domain}): ${f.filename}`);
          filesToRemove.add(f.filename);
        });
      }

      // 2. Identify files older than the retention period
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - config.screenshotRetentionDays);

      allFiles.forEach(file => {
        // Add to removal if it's older than retention cutoff AND not already marked
        if (file.stats.mtime.getTime() < cutoffDate.getTime() && !filesToRemove.has(file.filename)) {
          console.log(`Marking for removal (older than ${config.screenshotRetentionDays} days): ${file.filename}`);
          filesToRemove.add(file.filename);
        }
      });

      // 3. Perform deletions
      let deletedSize = 0;
      filesToRemove.forEach(filename => {
          try {
              const file = allFiles.find(f => f.filename === filename); // Find full file info
              if (file) {
                   fs.unlinkSync(file.path);
                   deletedSize += file.stats.size; // Track size removed
              }
          } catch (unlinkError) {
              console.error(`Error removing file ${filename}: ${unlinkError.message}`);
          }
      });
      if (filesToRemove.size > 0) {
          console.log(`Removed ${filesToRemove.size} files based on retention/count limits.`);
      }


      // 4. Check storage size limit and remove oldest if needed
      let currentSize = 0;
      const remainingFiles = fs.readdirSync(screenshotsDir)
         .filter(file => file.endsWith('.png'))
         .map(file => {
             try {
                const filePath = path.join(screenshotsDir, file);
                const stats = fs.statSync(filePath);
                return { path: filePath, stats: stats };
             } catch (statError) {
                console.error(`Could not get stats for remaining file ${file}: ${statError.message}`);
                return null;
             }
          })
         .filter(file => file !== null)
         .sort((a, b) => a.stats.mtime.getTime() - b.stats.mtime.getTime()); // Sort oldest first

      remainingFiles.forEach(file => currentSize += file.stats.size);

      if (currentSize > config.maxStorageSize) {
        console.log(`Storage limit still exceeded (${(currentSize / (1024*1024)).toFixed(2)}MB > ${(config.maxStorageSize / (1024*1024)).toFixed(2)}MB), removing oldest files...`);
        for (const file of remainingFiles) { // Iterate oldest first
          try {
            console.log(`Removing oldest file due to size limit: ${path.basename(file.path)}`);
            fs.unlinkSync(file.path);
            currentSize -= file.stats.size;
            if (currentSize <= config.maxStorageSize) {
              console.log(`Storage size now below limit.`);
              break; // Stop removing once under the limit
            }
          } catch (unlinkError) {
             console.error(`Error removing file ${path.basename(file.path)} for size limit: ${unlinkError.message}`);
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
      
      // First try: Normal load with 6 second timeout
      try {
        await page.goto(targetUrl, { 
          waitUntil: ['networkidle0', 'domcontentloaded', 'load'],
          timeout: 6000 // 6 second timeout
        });
      } catch (initialLoadError) {
        console.log(`Page load taking longer than 6 seconds, applying optimizations...`);
        
        // Apply performance optimizations
        await page.setRequestInterception(true);
        page.on('request', (request) => {
          const resourceType = request.resourceType();
          if (['media'].includes(resourceType)) {
            request.abort();
          } else {
            request.continue();
          }
        });

        // Retry with optimizations and longer timeout
        const pageLoadPromise = page.goto(targetUrl, { 
          waitUntil: 'networkidle2',
          timeout: 30000 // 30 second timeout
        });

        try {
          await pageLoadPromise;
        } catch (error) {
          console.log(`Page load timed out for ${targetUrl}, continuing with capture...`);
        }
      }

      // Ensure page is fully loaded
      console.log(`Waiting for page to be fully loaded...`);
      
      // Scroll through the page to ensure all lazy-loaded content is loaded
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
        domain: new URL(url).hostname,
        path: new URL(url).pathname || '/'
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
      // Process URLs in parallel with Promise.all
      const screenshotPromises = validUrls.map(url => 
        processUrl(url, targetLang, screenshotsDir)
      );
      
      // Wait for all screenshots to be taken
      const results = await Promise.all(screenshotPromises);
      
      // Filter out null results (failed screenshots)
      const screenshots = results.filter(result => result !== null).map(result => {
        // Extract page type information
        let pageType = 'Homepage';
        const url = new URL(result.originalUrl);
        if (url.pathname && url.pathname !== '/' && url.pathname !== '') {
          // Get the last part of the path for a more descriptive name
          const pathParts = url.pathname.split('/').filter(p => p);
          pageType = pathParts.length > 0 ? pathParts[pathParts.length - 1] : 'Section';
          
          // Capitalize and clean up the page type
          pageType = pageType
            .replace(/-/g, ' ')
            .replace(/\b\w/g, l => l.toUpperCase());
        }
        
        return {
          ...result,
          pageType
        };
      });

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

  // GET endpoint to retrieve screenshots by domain (revised)
  app.get('/screenshot/:domain', (req, res) => {
    let { domain: requestedDomain } = req.params; // Original request parameter

    if (!requestedDomain) {
      return res.status(400).send({ error: 'Domain parameter is required' });
    }

    // Normalize the requested domain: lowercase, remove protocol, remove trailing slash, remove www.
    let normalizedDomain = requestedDomain
                            .toLowerCase()
                            .replace(/^https?:\/\//, '')
                            .replace(/\/$/, '')
                            .replace(/^www\./, '');

    const screenshotsDir = path.join(__dirname, 'screenshots');

    try {
      if (!fs.existsSync(screenshotsDir)) {
         return res.status(404).send({ error: 'No screenshots found (screenshot directory does not exist)' });
      }

      // Get all PNG files, parse their info, and filter by the normalized domain
      const files = fs.readdirSync(screenshotsDir)
        .filter(file => file.endsWith('.png'))
        .map(file => {
           // Parse the filename to get the domain associated with this specific file
           const fileInfo = parseFilename(file);
           if (fileInfo.domain === 'unknown') return null; // Skip unparseable files

           try {
               const stats = fs.statSync(path.join(screenshotsDir, file));
               // Format the page type nicely from the section name
               let pageType = 'Homepage';
               if (!fileInfo.isHomepage && fileInfo.section) {
                   pageType = fileInfo.section
                       .replace(/_/g, ' ') // Replace underscores used in sanitization back to spaces
                       .replace(/\b\w/g, l => l.toUpperCase()); // Capitalize words
               }

               return {
                 filename: file,
                 fileDomain: fileInfo.domain, // The actual domain stored in the filename
                 url: `/screenshots/${file}`,
                 timestamp: stats.mtime,
                 pageType: pageType
               };
           } catch (statError) {
              console.error(`Could not get stats for screenshot file ${file}: ${statError.message}`);
              return null; // Skip files we can't get stats for
           }
        })
        .filter(file => file !== null && file.fileDomain === normalizedDomain) // Filter where file's domain matches the *normalized* requested domain
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)); // Sort by timestamp newest first

      if (files.length === 0) {
        return res.status(404).send({
          error: 'No screenshots found for this domain',
          message: `Looked for screenshots matching domain: ${normalizedDomain}`,
          suggestion: `Ensure screenshots were previously submitted with a URL resolving to this hostname (e.g., https://${normalizedDomain} or https://www.${normalizedDomain}).`
        });
      }

      // Return list of screenshots matching the normalized domain
      return res.status(200).send({
        domain: normalizedDomain, // Return the normalized domain that was searched for
        screenshots: files.map(file => ({ // Map to the expected output format
          filename: file.filename,
          url: file.url,
          timestamp: file.timestamp,
          pageType: file.pageType
        }))
      });
    } catch (error) {
      console.error(`Error retrieving screenshots for normalized domain ${normalizedDomain}: ${error}`);
      res.status(500).send({ error: 'Internal server error while retrieving screenshots' });
    }
  });

  // Endpoint to list all domains with screenshots (revised)
  app.get('/domains', (req, res) => {
    const screenshotsDir = path.join(__dirname, 'screenshots');

    try {
      if (!fs.existsSync(screenshotsDir)) {
        return res.json({ domains: [] });
      }

      // Create a map to hold domain info, keyed by the parsed domain name
      const domainMap = {};

      // Process each file to extract domain information and organize screenshots
      fs.readdirSync(screenshotsDir)
        .filter(file => file.endsWith('.png'))
        .forEach(file => {
          // Use the parseFilename helper function to extract info
          const fileInfo = parseFilename(file);

          // Skip if domain extraction failed or is invalid
          if (!fileInfo || fileInfo.domain === 'unknown') return;

          const domainKey = fileInfo.domain; // e.g., 'example.com'

          // Initialize the domain entry if it doesn't exist
          if (!domainMap[domainKey]) {
            domainMap[domainKey] = {
              name: domainKey, // Use the parsed domain name directly
              // Subdomains are implicitly handled as separate keys now if they exist
              screenshots: []
            };
          }

          try {
              const stats = fs.statSync(path.join(screenshotsDir, file));
              // Determine page type based on parsed info
              let pageType = 'Homepage';
              if (!fileInfo.isHomepage && fileInfo.section) {
                  pageType = fileInfo.section
                      .replace(/_/g, ' ') // Convert sanitization underscores back to spaces
                      .replace(/\b\w/g, l => l.toUpperCase()); // Capitalize
              }

              // Create screenshot object
              const screenshot = {
                filename: file,
                url: `/screenshots/${file}`,
                timestamp: stats.mtime,
                pageType: pageType,
                domain: domainKey // Associate with the parsed domain
              };

              // Add screenshot to the domain's list
              domainMap[domainKey].screenshots.push(screenshot);
          } catch (statError) {
               console.error(`Could not get stats for domain listing file ${file}: ${statError.message}`);
          }
        });

      // Convert map to array for response
      const domainsWithScreenshots = Object.values(domainMap)
        // Sort domains alphabetically by name
        .sort((a, b) => a.name.localeCompare(b.name))
        // Sort screenshots within each domain by timestamp (newest first)
        .map(domain => ({
          ...domain,
          screenshots: domain.screenshots.sort((a, b) =>
            new Date(b.timestamp) - new Date(a.timestamp)
          )
        }));

      res.json({ domains: domainsWithScreenshots });
    } catch (error) {
      console.error('Error getting domains:', error);
      res.status(500).json({ error: 'Failed to get domains' });
    }
  });

  // Endpoint to download all screenshots as ZIP (revised)
  app.get('/download-all', (req, res) => {
    const screenshotsDir = path.join(__dirname, 'screenshots');

    try {
      if (!fs.existsSync(screenshotsDir)) {
        return res.status(404).json({ error: 'No screenshots found (directory missing)' });
      }

      const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
      const zipFilename = `screenshots-${timestampStr}.zip`;
      res.attachment(zipFilename); // Suggest download filename

      const archive = archiver('zip', { zlib: { level: 9 } }); // Create zip archive

      // Pipe archive data to the response
      archive.pipe(res);

      // Handle warnings and errors during archiving
      archive.on('warning', (err) => {
          if (err.code === 'ENOENT') {
              console.warn('Archiver warning (file not found?):', err); // Log file not found warnings
          } else {
              // Throw other warnings as errors
              throw err;
          }
      });
      archive.on('error', (err) => {
          console.error('Archiver error:', err);
          // Try to send error response if headers not sent yet
          if (!res.headersSent) {
              res.status(500).json({ error: 'Failed to create ZIP archive during processing' });
          }
      });
       // Signal end of response when archive is finalized
       archive.on('end', () => {
          console.log('ZIP archive finalized successfully.');
       });


      // Get list of files to add
      const files = fs.readdirSync(screenshotsDir)
        .filter(file => file.endsWith('.png'));

      console.log(`Archiving ${files.length} screenshot files...`);

      // Process each file and add it to the archive with a structured path
      files.forEach(file => {
        const filePath = path.join(screenshotsDir, file);
        try {
          // Use the parseFilename helper to get structured info
          const fileInfo = parseFilename(file);

          // Skip files with unknown domains
          if (fileInfo.domain === 'unknown') {
            console.warn(`Skipping file with unknown domain in ZIP archive: ${file}`);
            return;
          }

          // Determine the path inside the ZIP file
          const domainDir = fileInfo.domain; // e.g., 'example.com'
          let baseFilename = 'index'; // Default for homepage screenshots

          if (!fileInfo.isHomepage && fileInfo.section) {
             // Use the section name for the filename (keep underscores for consistency)
             baseFilename = fileInfo.section;
          }

          // Construct the path within the ZIP archive: Domain/Section.png or Domain/index.png
          const zipPath = `${domainDir}/${baseFilename}.png`;

          // Add the file to the archive
          console.log(`Adding to archive: ${filePath} as ${zipPath}`);
          archive.file(filePath, { name: zipPath });

        } catch(parseError) {
            // Log errors encountered while processing individual files for the archive
            console.error(`Error processing file ${file} for ZIP archive: ${parseError.message}`);
        }
      });

      // Finalize the archive (no more files will be added)
      archive.finalize();

    } catch (error) {
      // Catch synchronous errors that might occur before archiving starts
      console.error('Error initiating ZIP archive creation:', error);
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