const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();

// Middleware de base avec gestion d'erreurs
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Timeout middleware
app.use((req, res, next) => {
  req.setTimeout(300000); // 5 minutes
  res.setTimeout(300000);
  next();
});

// Health check amélioré
app.get('/health', (req, res) => {
  try {
    // Vérifier les dépendances système
    const checks = {
      node: process.version,
      platform: process.platform,
      memory: process.memoryUsage(),
      uptime: process.uptime(),
      tmpDir: fs.existsSync('/tmp') ? 'accessible' : 'not accessible'
    };

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      checks
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

// Info endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'Vimeo Audio Downloader API',
    version: '2.2.1',
    status: 'running',
    endpoints: {
      'GET /': 'API information',
      'GET /health': 'Health check',
      'POST /download-audio': 'Download audio from Vimeo URL'
    }
  });
});

// Helper functions
function extractVideoId(url) {
  if (!url) return null;
  
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

function extractHash(url) {
  const match = url.match(/[?&]h=([a-f0-9]+)/);
  return match ? match[1] : null;
}

// Route principale avec gestion d'erreurs complète
app.post('/download-audio', async (req, res) => {
  console.log('Download request received:', req.body);
  
  try {
    const { vimeoUrl, videoId: providedVideoId, startTime, endTime } = req.body;
    
    if (!vimeoUrl) {
      return res.status(400).json({ 
        error: 'Missing vimeoUrl',
        details: 'vimeoUrl is required in request body'
      });
    }

    const videoId = providedVideoId || extractVideoId(vimeoUrl);
    const hash = extractHash(vimeoUrl);
    
    if (!videoId) {
      return res.status(400).json({ 
        error: 'Invalid Vimeo URL',
        details: 'Could not extract video ID from URL',
        url: vimeoUrl.substring(0, 100) + '...'
      });
    }

    console.log(`Processing video ${videoId}${hash ? ' with hash ' + hash : ''}`);
    
    const timestamp = Date.now();
    const fullAudioPath = `/tmp/audio_${videoId}_${timestamp}.mp3`;
    
    // Vérifier que /tmp est accessible
    try {
      fs.accessSync('/tmp', fs.constants.W_OK);
    } catch (error) {
      return res.status(500).json({
        error: 'Storage not accessible',
        details: 'Cannot write to /tmp directory'
      });
    }

    // URLs à essayer
    const urlsToTry = [];
    
    if (hash) {
      urlsToTry.push(`https://player.vimeo.com/video/${videoId}?h=${hash}`);
      urlsToTry.push(vimeoUrl);
    } else {
      urlsToTry.push(vimeoUrl);
    }
    
    urlsToTry.push(`https://vimeo.com/${videoId}`);
    urlsToTry.push(`https://player.vimeo.com/video/${videoId}`);

    // Téléchargement avec retry
    let downloadSuccess = false;
    let lastError = null;

    for (let i = 0; i < urlsToTry.length; i++) {
      try {
        await attemptDownload(urlsToTry[i], fullAudioPath, i);
        downloadSuccess = true;
        break;
      } catch (error) {
        lastError = error;
        // Nettoyer les fichiers temporaires
        if (fs.existsSync(fullAudioPath)) {
          fs.unlinkSync(fullAudioPath);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
    }

    if (!downloadSuccess) {
      return res.status(500).json({
        error: 'Download failed',
        details: lastError?.message || 'All download methods failed',
        videoId: videoId
      });
    }

    // Vérifier le fichier
    if (!fs.existsSync(fullAudioPath) || fs.statSync(fullAudioPath).size === 0) {
      return res.status(500).json({ 
        error: 'Audio file creation failed',
        details: 'File is empty or was not created'
      });
    }

    console.log(`Audio downloaded successfully: ${(fs.statSync(fullAudioPath).size / (1024 * 1024)).toFixed(2)} MB`);

    // Gérer les chunks ou le fichier complet
    if (startTime !== undefined && endTime !== undefined) {
      await handleAudioChunk(req, res, fullAudioPath, videoId, startTime, endTime, timestamp);
    } else {
      await handleFullAudio(req, res, fullAudioPath, videoId);
    }

  } catch (error) {
    console.error('Unhandled error in download-audio:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Fonction de téléchargement
function attemptDownload(url, outputPath, attemptIndex) {
  return new Promise((resolve, reject) => {
    console.log(`Attempt ${attemptIndex + 1}: ${url.substring(0, 80)}...`);
    
    const command = `yt-dlp \
      --no-check-certificate \
      --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
      --referer "https://vimeo.com/" \
      --retries 2 \
      -x --audio-format mp3 \
      --audio-quality 0 \
      --no-playlist \
      -o "${outputPath}" \
      "${url}"`;
    
    exec(command, { 
      maxBuffer: 50 * 1024 * 1024,
      timeout: 120000
    }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        resolve();
      } else {
        reject(new Error('Downloaded file is empty'));
      }
    });
  });
}

// Gestion des chunks audio
function handleAudioChunk(req, res, fullAudioPath, videoId, startTime, endTime, timestamp) {
  const chunkPath = `/tmp/chunk_${videoId}_${startTime}_${endTime}_${timestamp}.mp3`;
  const duration = endTime - startTime;
  
  const ffmpegCommand = `ffmpeg -ss ${startTime} -i "${fullAudioPath}" -t ${duration} -c copy "${chunkPath}" -y`;
  
  exec(ffmpegCommand, { timeout: 60000 }, (error) => {
    // Cleanup original file
    if (fs.existsSync(fullAudioPath)) {
      fs.unlinkSync(fullAudioPath);
    }

    if (error || !fs.existsSync(chunkPath)) {
      return res.status(500).json({
        error: 'Chunk creation failed',
        details: error?.message
      });
    }

    res.download(chunkPath, `chunk_${videoId}_${startTime}_${endTime}.mp3`, (err) => {
      if (fs.existsSync(chunkPath)) {
        fs.unlinkSync(chunkPath);
      }
      if (err) console.error('Download error:', err);
    });
  });
}

// Gestion audio complet
function handleFullAudio(req, res, fullAudioPath, videoId) {
  res.download(fullAudioPath, `audio_${videoId}.mp3`, (err) => {
    if (fs.existsSync(fullAudioPath)) {
      fs.unlinkSync(fullAudioPath);
    }
    if (err) console.error('Download error:', err);
  });
}

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Global error handler:', error);
  res.status(500).json({
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'production' ? 'Something went wrong' : error.message
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.originalUrl
  });
});

// Démarrage du serveur
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Vimeo Audio Downloader API v2.2.1 running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📁 Temp directory: ${fs.existsSync('/tmp') ? 'accessible' : 'NOT accessible'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});