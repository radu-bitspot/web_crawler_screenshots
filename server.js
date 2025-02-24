const puppeteer = require('puppeteer');
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

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

// Helper function to generate timestamp
const getTimestamp = () => {
  return new Date().toISOString().replace(/[:.]/g, '-');
};

// Helper function to sanitize filenames
const sanitizeFilename = (url) => {
  try {
    const { hostname, pathname } = new URL(url);
    const sanitizedPath = pathname.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    return `${hostname}${sanitizedPath}`.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  } catch (error) {
    console.error(`Invalid URL: ${url}`);
    return 'invalid_url';
  }
};

// Helper function to generate unique filename
const generateUniqueFilename = (url) => {
  const timestamp = getTimestamp();
  const sanitized = sanitizeFilename(url);
  return `screenshot-${sanitized}-${timestamp}.png`;
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

// Run cleanup every hour
setInterval(cleanupOldScreenshots, 60 * 60 * 1000);

// Endpoint to take screenshots
app.post('/screenshot', async (req, res) => {
  // Run cleanup before processing new screenshots
  cleanupOldScreenshots();

  console.log('Received POST request to /screenshot');
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

  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const screenshotsDir = path.join(__dirname, 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    console.log('Creating screenshots directory...');
    fs.mkdirSync(screenshotsDir);
  }

  try {
    const page = await browser.newPage();
    console.log('Browser page created');

    const screenshots = [];  // Array to store screenshot information

    for (const url of validUrls) {
      console.log(`Processing URL: ${url}`);
      let targetUrl = url;

      // Handle translation if required
      if (targetLang) {
        targetUrl = `https://translate.google.com/translate?hl=${targetLang}&sl=auto&tl=${targetLang}&u=${encodeURIComponent(url)}`;
        console.log(`Translated URL: ${targetUrl}`);
      }

      // Take a screenshot with error handling
      try {
        console.log(`Navigating to: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        const filename = generateUniqueFilename(url);
        const screenshotPath = path.join(screenshotsDir, filename);
        console.log(`Taking screenshot: ${screenshotPath}`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`Screenshot taken for: ${url}`);
        
        // Add screenshot info to array
        screenshots.push({
          originalUrl: url,
          filename: filename,
          screenshotUrl: `/screenshots/${filename}`,
          timestamp: new Date().toISOString(),
          domain: new URL(url).hostname
        });
      } catch (err) {
        console.error(`Failed to capture screenshot for ${url}: ${err.message}`);
      }
    }

    await browser.close();
    console.log('Browser closed');

    console.log('Sending success response');
    return res.status(200).send({ 
      message: 'Screenshots created successfully',
      screenshots: screenshots
    });
  } catch (error) {
    console.error(`Processing error: ${error.message}`);
    await browser.close();
    return res.status(500).send({ error: 'An error occurred while processing screenshots' });
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

// Serve static files from the "screenshots" directory with proper headers
app.use('/screenshots', express.static(path.join(__dirname, 'screenshots'), {
  setHeaders: (res, path) => {
    // Set cache control for better performance
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (path.endsWith('.png')) {
      res.setHeader('Content-Type', 'image/png');
    }
  }
}));

app.listen(port, () => {
  console.log(`API listening at http://localhost:${port}`);
});
