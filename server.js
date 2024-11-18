const puppeteer = require('puppeteer');
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

const app = express();
const port = 3005;

app.use(bodyParser.json());

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

// Endpoint to take screenshots and create an archive
app.post('/screenshot', async (req, res) => {
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

  if (!urlList || !Array.isArray(urlList) || urlList.length === 0) {
    return res.status(400).send({ error: 'Invalid input' });
  }

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const screenshotsDir = path.join(__dirname, 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir);
  }

  const domain = new URL(urlList[0]).hostname;
  const archivePath = path.join(screenshotsDir, `${domain}.zip`);
  const output = fs.createWriteStream(archivePath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  output.on('close', () => {
    console.log(`${archive.pointer()} total bytes`);
    console.log(`Archive ${archivePath} has been finalized.`);
  });

  archive.on('error', (err) => {
    console.error(`Archive error: ${err.message}`);
    return res.status(500).send({ error: 'Error creating archive' });
  });

  archive.pipe(output);

  try {
    const page = await browser.newPage();
    for (const url of urlList) {
      let targetUrl = url;

      // Handle translation if required
      if (targetLang) {
        targetUrl = `https://translate.google.com/translate?hl=${targetLang}&sl=auto&tl=${targetLang}&u=${encodeURIComponent(url)}`;
      }

      // Take a screenshot with error handling
      try {
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        const sanitizedFilename = sanitizeFilename(url);
        const screenshotPath = path.join(screenshotsDir, `screenshot-${sanitizedFilename}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`Screenshot taken for: ${url}`);
        archive.file(screenshotPath, { name: path.basename(screenshotPath) });
      } catch (err) {
        console.error(`Failed to capture screenshot for ${url}: ${err.message}`);
      }
    }

    await archive.finalize();
    await browser.close();

    // Cleanup screenshot files after archiving
    fs.readdir(screenshotsDir, (err, files) => {
      if (err) console.error(`Error reading directory: ${err.message}`);
      files.forEach(file => {
        if (file.endsWith('.png')) {
          fs.unlink(path.join(screenshotsDir, file), err => {
            if (err) console.error(`Error deleting file: ${err.message}`);
          });
        }
      });
    });

    return res.status(200).send({ message: 'Screenshots and archive created successfully', archive: `${domain}.zip` });

  } catch (error) {
    console.error(`Processing error: ${error.message}`);
    await browser.close();
    return res.status(500).send({ error: 'An error occurred while processing screenshots' });
  }
});

// Serve static files from the "screenshots" directory
app.use('/screenshots', express.static(path.join(__dirname, 'screenshots')));

app.listen(port, () => {
  console.log(`API listening at http://localhost:${port}`);
});
