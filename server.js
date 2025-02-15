const puppeteer = require('puppeteer');
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

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
      .filter(file => file.endsWith('.png') || file.endsWith('.zip'))
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

// Endpoint to take screenshots and create an archive
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
    // Get domain from first valid URL
    const domain = new URL(validUrls[0]).hostname;
    console.log('Using domain:', domain);
    
    const timestamp = getTimestamp();
    const archiveName = `${domain}-${timestamp}.zip`;
    const archivePath = path.join(screenshotsDir, archiveName);
    console.log('Archive path:', archivePath);
    
    const output = fs.createWriteStream(archivePath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      console.log(`Archive completed: ${archive.pointer()} total bytes`);
      console.log(`Archive ${archivePath} has been finalized.`);
    });

    archive.on('error', (err) => {
      console.error(`Archive error: ${err.message}`);
      return res.status(500).send({ error: 'Error creating archive' });
    });

    archive.pipe(output);

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
          domain: domain
        });

        archive.file(screenshotPath, { name: filename });
      } catch (err) {
        console.error(`Failed to capture screenshot for ${url}: ${err.message}`);
      }
    }

    console.log('Finalizing archive...');
    await archive.finalize();
    await browser.close();
    console.log('Browser closed');

    console.log('Sending success response');
    return res.status(200).send({ 
      message: 'Screenshots created successfully',
      archive: archiveName,
      archiveUrl: `/screenshots/${archiveName}`,
      screenshots: screenshots
    });

  } catch (error) {
    console.error(`Processing error: ${error.message}`);
    await browser.close();
    return res.status(500).send({ error: 'An error occurred while processing screenshots' });
  }
});

// GET endpoint to retrieve screenshot archive by domain
app.get('/screenshot/:domain', (req, res) => {
  const { domain } = req.params;
  
  if (!domain) {
    return res.status(400).send({ error: 'Domain parameter is required' });
  }

  const screenshotsDir = path.join(__dirname, 'screenshots');
  const archivePath = path.join(screenshotsDir, `${domain}.zip`);

  // Check if the archive exists
  if (!fs.existsSync(archivePath)) {
    return res.status(404).send({ error: 'No screenshots found for this domain' });
  }

  // Set headers for file download
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename=${domain}.zip`);

  // Stream the file to the response
  const fileStream = fs.createReadStream(archivePath);
  fileStream.pipe(res);
});

// Endpoint to list all screenshots, grouped by domain
app.get('/screenshots/list', (req, res) => {
  const screenshotsDir = path.join(__dirname, 'screenshots');
  
  if (!fs.existsSync(screenshotsDir)) {
    return res.status(200).send({ screenshots: [] });
  }

  try {
    const files = fs.readdirSync(screenshotsDir)
      .filter(file => file.endsWith('.png'))
      .map(file => {
        const stats = fs.statSync(path.join(screenshotsDir, file));
        // Extract domain from filename (format: screenshot-domain-timestamp.png)
        const parts = file.split('-');
        const domain = parts[1]; // Get domain part
        return {
          filename: file,
          url: `/screenshots/${file}`,
          domain: domain,
          created: stats.mtime,
          size: stats.size
        };
      })
      .sort((a, b) => b.created - a.created); // Sort by creation date, newest first

    // Group screenshots by domain
    const groupedScreenshots = files.reduce((groups, screenshot) => {
      const domain = screenshot.domain;
      if (!groups[domain]) {
        groups[domain] = [];
      }
      groups[domain].push(screenshot);
      return groups;
    }, {});

    res.status(200).send({ 
      screenshots: groupedScreenshots,
      total: files.length
    });
  } catch (error) {
    console.error('Error reading screenshots directory:', error);
    res.status(500).send({ error: 'Failed to list screenshots' });
  }
});

// Endpoint to get a specific screenshot by filename
app.get('/screenshot/:filename', (req, res) => {
  const { filename } = req.params;
  const screenshotPath = path.join(__dirname, 'screenshots', filename);

  if (!fs.existsSync(screenshotPath)) {
    return res.status(404).send({ error: 'Screenshot not found' });
  }

  res.sendFile(screenshotPath);
});

// Serve static files from the "screenshots" directory with proper headers
app.use('/screenshots', express.static(path.join(__dirname, 'screenshots')));

app.listen(port, () => {
  console.log(`API listening at http://localhost:${port}`);
});
