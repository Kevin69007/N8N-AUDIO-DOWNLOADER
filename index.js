const express = require('express');
const { spawn } = require('child_process');
const app = express();

app.use(express.json());

// Extract Vimeo video ID
function extractVideoId(url) {
  const patterns = [
    /vimeo\.com\/video\/(\d+)/,
    /player\.vimeo\.com\/video\/(\d+)/,
    /vimeo\.com\/(\d+)/,
    /video\/(\d+)/,
    /\/(\d+)\?/,
    /\/(\d+)$/
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// Extract hash if exists
function extractHash(url) {
  const m = url.match(/[?&]h=([a-f0-9]+)/);
  return m ? m[1] : null;
}

// Returns array of URLs to try
function buildUrls(vimeoUrl, videoId, hash) {
  const urls = [];
  if (hash) {
    urls.push(`https://player.vimeo.com/video/${videoId}?h=${hash}`);
    urls.push(vimeoUrl);
  } else {
    urls.push(vimeoUrl);
  }
  urls.push(`https://vimeo.com/${videoId}`);
  urls.push(`https://player.vimeo.com/video/${videoId}`);
  return urls;
}

// Spawn yt-dlp with stdout piping
function spawnYtDlp(url) {
  return spawn('yt-dlp', [
    '-x',
    '--audio-format', 'mp3',
    '-o', '-',
    '--no-playlist',
    '--retries', '3',
    url
  ]);
}

// Attempt streaming with retries
async function streamWithRetries(urls, res, startTime, endTime) {
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    for (let attempt = 0; attempt < 3; attempt++) {
      console.log(`Trying URL ${i + 1}/${urls.length}, attempt ${attempt + 1}: ${url}`);
      try {
        await new Promise((resolve, reject) => {
          const ytDlp = spawnYtDlp(url);

          let ffmpeg;
          if (startTime !== undefined && endTime !== undefined) {
            const duration = endTime - startTime;
            ffmpeg = spawn('ffmpeg', [
              '-ss', startTime.toString(),
              '-i', 'pipe:0',
              '-t', duration.toString(),
              '-c:a', 'libmp3lame',
              '-b:a', '128k',
              '-ar', '44100',
              '-f', 'mp3',
              'pipe:1'
            ]);

            ytDlp.stdout.pipe(ffmpeg.stdin);
            ffmpeg.stdout.pipe(res);

            ffmpeg.stderr.on('data', d => console.error('ffmpeg stderr:', d.toString()));
            ffmpeg.on('error', reject);
            ffmpeg.on('close', code => {
              if (code !== 0) reject(new Error(`ffmpeg exited with ${code}`));
              else resolve();
            });
          } else {
            ytDlp.stdout.pipe(res);
            ytDlp.on('close', code => {
              if (code !== 0) reject(new Error(`yt-dlp exited with ${code}`));
              else resolve();
            });
          }

          ytDlp.stderr.on('data', d => console.error('yt-dlp stderr:', d.toString()));
          ytDlp.on('error', reject);
        });
        return; // success
      } catch (err) {
        console.error(`Attempt ${attempt + 1} failed for URL: ${url}`, err.message);
        if (attempt === 2 && i === urls.length - 1) {
          throw new Error('All download attempts failed');
        }
      }
    }
  }
}

app.post('/download-audio', async (req, res) => {
  const { vimeoUrl, videoId: providedVideoId, startTime, endTime } = req.body;

  if (!vimeoUrl) return res.status(400).json({ error: 'Missing vimeoUrl' });

  const videoId = providedVideoId || extractVideoId(vimeoUrl);
  const hash = extractHash(vimeoUrl);
  if (!videoId) return res.status(400).json({ error: 'Could not extract video ID' });

  const urlsToTry = buildUrls(vimeoUrl, videoId, hash);

  res.setHeader('Content-Type', 'audio/mpeg');
  if (startTime !== undefined && endTime !== undefined) {
    res.setHeader('Content-Disposition', `attachment; filename="chunk_${videoId}_${startTime}_${endTime}.mp3"`);
  } else {
    res.setHeader('Content-Disposition', `attachment; filename="audio_${videoId}.mp3"`);
  }

  try {
    await streamWithRetries(urlsToTry, res, startTime, endTime);
    console.log('Streaming completed successfully');
  } catch (err) {
    console.error('Streaming failed:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message, triedUrls: urlsToTry });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Robust Vimeo Audio Downloader running on port ${PORT}`));
