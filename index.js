const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    service: 'Vimeo Audio Downloader API',
    version: '2.2.0',
    endpoints: {
      'GET /': 'API information',
      'GET /health': 'Health check',
      'POST /download-audio': 'Download audio from Vimeo URL'
    }
  });
});

// Helper to extract video ID from various Vimeo URL formats
function extractVideoId(url) {
  const patterns = [
    /vimeo\.com\/video\/(\d+)/,
    /player\.vimeo\.com\/video\/(\d+)/,
    /vimeo\.com\/(\d+)/,
    /video\/(\d+)/,
    /\/(\d+)\?/,
    /\/(\d+)$/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// Helper to extract hash parameter
function extractHash(url) {
  const match = url.match(/[?&]h=([a-f0-9]+)/);
  return match ? match[1] : null;
}

app.post('/download-audio', async (req, res) => {
  const { vimeoUrl, videoId: providedVideoId, startTime, endTime } = req.body;
  
  if (!vimeoUrl) {
    return res.status(400).json({ error: 'Missing vimeoUrl' });
  }

  const videoId = providedVideoId || extractVideoId(vimeoUrl);
  const hash = extractHash(vimeoUrl);
  
  if (!videoId) {
    return res.status(400).json({ error: 'Could not extract video ID from URL' });
  }

  console.log(`Processing video ${videoId}${hash ? ' with hash ' + hash : ''}`);
  
  const timestamp = Date.now();
  const fullAudioPath = `/tmp/audio_${videoId}_${timestamp}.mp3`;
  
  // Build URLs to try with priority order
  const urlsToTry = [];
  
  // If we have a hash, prioritize player URL with hash
  if (hash) {
    urlsToTry.push(`https://player.vimeo.com/video/${videoId}?h=${hash}`);
    urlsToTry.push(vimeoUrl); // Original URL
  } else {
    urlsToTry.push(vimeoUrl); // Original URL first
  }
  
  // Add standard formats as fallbacks
  urlsToTry.push(`https://vimeo.com/${videoId}`);
  urlsToTry.push(`https://player.vimeo.com/video/${videoId}`);

  // Function to try downloading with a URL
  const tryDownload = (url, index) => {
    return new Promise((resolve, reject) => {
      console.log(`Attempt ${index + 1}: Trying URL: ${url.substring(0, 80)}...`);
      
      // Enhanced yt-dlp command with aggressive retry options
      const command = `yt-dlp \
        --no-check-certificate \
        --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
        --referer "https://vimeo.com/" \
        --add-header "Accept: */*" \
        --add-header "Accept-Language: en-US,en;q=0.9" \
        --add-header "Sec-Fetch-Mode: navigate" \
        --retries 3 \
        --fragment-retries 3 \
        -x --audio-format mp3 \
        --audio-quality 0 \
        --no-playlist \
        --no-warnings \
        -o "${fullAudioPath}" \
        "${url}"`;
      
      exec(command, { 
        maxBuffer: 150 * 1024 * 1024,
        timeout: 180000 // 3 minute timeout
      }, (error, stdout, stderr) => {
        console.log(`yt-dlp output: ${stdout}`);
        if (stderr) console.error(`yt-dlp stderr: ${stderr}`);
        
        if (error) {
          console.error(`Attempt ${index + 1} failed:`, error.message);
          reject(error);
        } else if (fs.existsSync(fullAudioPath) && fs.statSync(fullAudioPath).size > 0) {
          console.log(`Attempt ${index + 1} succeeded! File size: ${fs.statSync(fullAudioPath).size} bytes`);
          resolve();
        } else {
          reject(new Error('File not created or is empty'));
        }
      });
    });
  };

  // Try each URL until one works
  let downloadSuccess = false;
  let lastError = null;

  for (let i = 0; i < urlsToTry.length; i++) {
    try {
      await tryDownload(urlsToTry[i], i);
      downloadSuccess = true;
      break;
    } catch (error) {
      lastError = error;
      // Clean up failed attempt
      if (fs.existsSync(fullAudioPath)) {
        fs.unlinkSync(fullAudioPath);
      }
      // Wait a bit before next attempt
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }
  }

  if (!downloadSuccess) {
    console.error('All download attempts failed');
    return res.status(500).json({
      error: 'Failed to download audio from Vimeo',
      details: lastError?.message || 'All methods failed',
      triedUrls: urlsToTry,
      videoId: videoId,
      hasHash: !!hash
    });
  }

  // Verify file exists and has content
  if (!fs.existsSync(fullAudioPath)) {
    return res.status(500).json({ error: 'Audio file was not created' });
  }
  
  const fileSize = fs.statSync(fullAudioPath).size;
  if (fileSize === 0) {
    fs.unlinkSync(fullAudioPath);
    return res.status(500).json({ error: 'Audio file is empty' });
  }

  console.log(`Audio downloaded successfully: ${(fileSize / (1024 * 1024)).toFixed(2)} MB`);

  // If chunk parameters provided, extract chunk
  if (startTime !== undefined && endTime !== undefined) {
    const chunkPath = `/tmp/chunk_${videoId}_${startTime}_${endTime}_${timestamp}.mp3`;
    const duration = endTime - startTime;
    
    // Use more compatible FFmpeg options
    const ffmpegCommand = `ffmpeg -ss ${startTime} -i "${fullAudioPath}" -t ${duration} -c:a libmp3lame -b:a 128k -ar 44100 "${chunkPath}" -y`;
    
    console.log(`Creating chunk: ${startTime}s to ${endTime}s (duration: ${duration}s)`);
    
    exec(ffmpegCommand, { 
      maxBuffer: 100 * 1024 * 1024,
      timeout: 60000 
    }, (ffmpegError, ffmpegStdout, ffmpegStderr) => {
      // Clean up full audio file
      if (fs.existsSync(fullAudioPath)) {
        fs.unlinkSync(fullAudioPath);
      }

      if (ffmpegError) {
        console.error('FFmpeg error:', ffmpegError);
        console.error('FFmpeg stderr:', ffmpegStderr);
        return res.status(500).json({
          error: 'Failed to create audio chunk',
          details: ffmpegError.message
        });
      }

      if (!fs.existsSync(chunkPath)) {
        return res.status(500).json({ error: 'Audio chunk was not created' });
      }
      
      const chunkStats = fs.statSync(chunkPath);
      if (chunkStats.size === 0) {
        fs.unlinkSync(chunkPath);
        return res.status(500).json({ error: 'Audio chunk is empty' });
      }
      
      const fileSizeInMB = (chunkStats.size / (1024 * 1024)).toFixed(2);
      
      console.log(`Chunk created successfully: ${fileSizeInMB} MB`);

      res.download(chunkPath, `chunk_${videoId}_${startTime}_${endTime}.mp3`, (downloadErr) => {
        if (fs.existsSync(chunkPath)) {
          fs.unlinkSync(chunkPath);
        }
        
        if (downloadErr) {
          console.error('Chunk download error:', downloadErr);
        } else {
          console.log('Chunk sent successfully');
        }
      });
    });

  } else {
    // Send full audio
    const stats = fs.statSync(fullAudioPath);
    const fileSizeInMB = (stats.size / (1024 * 1024)).toFixed(2);
    
    console.log(`Sending full audio: ${fileSizeInMB} MB`);

    res.download(fullAudioPath, `audio_${videoId}.mp3`, (err) => {
      if (fs.existsSync(fullAudioPath)) {
        fs.unlinkSync(fullAudioPath);
      }
      
      if (err) {
        console.error('Download error:', err);
      } else {
        console.log('Full audio sent successfully');
      }
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    tmpDir: fs.existsSync('/tmp') ? 'accessible' : 'not accessible'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Vimeo Audio Downloader API v2.2.0 running on port ${PORT}`);
  console.log(`Temp directory: ${fs.existsSync('/tmp') ? '/tmp accessible' : '/tmp NOT accessible'}`);
});