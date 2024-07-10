

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
  const translate = req.headers['translate-to-romanian'];

  // Check if URLs is a single string and split it
  let urlList = urls;
  if (typeof urls === 'string') {
    urlList = urls.split(',').map(url => url.trim());
  }

  if (!urlList || !Array.isArray(urlList) || urlList.length === 0) {
    return res.status(400).send({ error: 'Invalid input' });
  }

  try {
    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    const screenshotsDir = path.join(__dirname, 'screenshots');
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir);
    }

    const domain = new URL(urlList[0]).hostname;
    const archivePath = path.join(screenshotsDir, `${domain}.zip`);
    const output = fs.createWriteStream(archivePath);
    const archive = archiver('zip', {
      zlib: { level: 9 }
    });

    output.on('close', () => {
      console.log(`${archive.pointer()} total bytes`);
      console.log(`Archive ${archivePath} has been finalized.`);
      // Clean up the screenshot files
      fs.readdir(screenshotsDir, (err, files) => {
        if (err) throw err;
        for (const file of files) {
          if (file.endsWith('.png')) {
            fs.unlink(path.join(screenshotsDir, file), err => {
              if (err) throw err;
            });
          }
        }
      });
    });

    archive.on('error', (err) => {
      throw err;
    });

    archive.pipe(output);

    for (const url of urlList) {
      const targetUrl = translate ? `https://translate.google.com/translate?hl=ro&sl=auto&tl=ro&u=${encodeURIComponent(url)}` : url;
      await page.goto(targetUrl, { waitUntil: 'networkidle2' });
      const sanitizedFilename = sanitizeFilename(url);
      const screenshotPath = path.join(screenshotsDir, `screenshot-${sanitizedFilename}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`Screenshot taken for: ${url}`);
      archive.file(screenshotPath, { name: path.basename(screenshotPath) });
    }

    await browser.close();
    await archive.finalize();

    return res.status(200).send({ message: 'Screenshots and archive created successfully', archive: `${domain}.zip` });

  } catch (error) {
    console.error(error);
    return res.status(500).send({ error: 'An error occurred while taking screenshots and creating the archive' });
  }
});

// Serve static files from the "screenshots" directory
app.use('/screenshots', express.static(path.join(__dirname, 'screenshots')));

app.listen(port, () => {
  console.log(`API listening at http://localhost:${port}`);
});

