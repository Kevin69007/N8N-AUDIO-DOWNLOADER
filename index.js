const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();

app.use(express.json());

// Store for job statuses
const jobs = new Map();

// Cleanup old jobs (older than 1 hour)
setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    if (now - job.createdAt > 3600000) { // 1 hour
      // Clean up files
      if (job.filePath && fs.existsSync(job.filePath)) {
        try {
          fs.unlinkSync(job.filePath);
        } catch (e) {
          console.error(`Error cleaning up file ${job.filePath}:`, e);
        }
      }
      if (job.chunkPath && fs.existsSync(job.chunkPath)) {
        try {
          fs.unlinkSync(job.chunkPath);
        } catch (e) {
          console.error(`Error cleaning up chunk ${job.chunkPath}:`, e);
        }
      }
      jobs.delete(jobId);
    }
  }
}, 60000); // Run cleanup every minute

app.get('/', (req, res) => {
  res.json({
    service: 'Vimeo Audio Downloader API',
    version: '2.3.0',
    endpoints: {
      'GET /': 'API information',
      'GET /health': 'Health check',
      'POST /download-audio': 'Start async audio download from Vimeo URL (returns jobId)',
      'GET /download-status/:jobId': 'Check download job status',
      'GET /download-result/:jobId': 'Get downloaded audio file (when status is completed)'
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

  // Generate unique job ID
  const jobId = crypto.randomBytes(16).toString('hex');
  const timestamp = Date.now();
  const fullAudioPath = `/tmp/audio_${videoId}_${timestamp}.mp3`;
  
  // Create job entry
  const job = {
    jobId,
    videoId,
    hash,
    status: 'processing',
    createdAt: timestamp,
    filePath: null,
    chunkPath: null,
    error: null,
    startTime,
    endTime
  };
  
  jobs.set(jobId, job);

  console.log(`[Job ${jobId}] Processing video ${videoId}${hash ? ' with hash ' + hash : ''}`);
  
  // Start download asynchronously (don't await)
  processDownload(job, vimeoUrl, fullAudioPath).catch(err => {
    console.error(`[Job ${jobId}] Fatal error:`, err);
    job.status = 'error';
    job.error = err.message || 'Unknown error';
  });
  
  // Return immediately with job ID
  res.json({
    jobId,
    status: 'processing',
    message: 'Download started',
    checkStatusUrl: `/download-status/${jobId}`,
    resultUrl: `/download-result/${jobId}`
  });
});

// Async function to process the download
async function processDownload(job, vimeoUrl, fullAudioPath) {
  const { jobId, videoId, hash, startTime, endTime } = job;
  
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
      console.log(`[Job ${jobId}] Attempt ${index + 1}: Trying URL: ${url.substring(0, 80)}...`);
      
      // Enhanced yt-dlp command with aggressive retry options and increased timeout
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
        timeout: 600000 // 10 minute timeout (increased from 3 minutes)
      }, (error, stdout, stderr) => {
        console.log(`[Job ${jobId}] yt-dlp output: ${stdout}`);
        if (stderr) console.error(`[Job ${jobId}] yt-dlp stderr: ${stderr}`);
        
        if (error) {
          console.error(`[Job ${jobId}] Attempt ${index + 1} failed:`, error.message);
          reject(error);
        } else if (fs.existsSync(fullAudioPath) && fs.statSync(fullAudioPath).size > 0) {
          console.log(`[Job ${jobId}] Attempt ${index + 1} succeeded! File size: ${fs.statSync(fullAudioPath).size} bytes`);
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
        try {
          fs.unlinkSync(fullAudioPath);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
      // Wait a bit before next attempt
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }
  }

  if (!downloadSuccess) {
    console.error(`[Job ${jobId}] All download attempts failed`);
    job.status = 'error';
    job.error = lastError?.message || 'All methods failed';
    return;
  }

  // Verify file exists and has content
  if (!fs.existsSync(fullAudioPath)) {
    job.status = 'error';
    job.error = 'Audio file was not created';
    return;
  }
  
  const fileSize = fs.statSync(fullAudioPath).size;
  if (fileSize === 0) {
    try {
      fs.unlinkSync(fullAudioPath);
    } catch (e) {
      // Ignore cleanup errors
    }
    job.status = 'error';
    job.error = 'Audio file is empty';
    return;
  }

  console.log(`[Job ${jobId}] Audio downloaded successfully: ${(fileSize / (1024 * 1024)).toFixed(2)} MB`);
  job.filePath = fullAudioPath;

  // If chunk parameters provided, extract chunk
  if (startTime !== undefined && endTime !== undefined) {
    const chunkPath = `/tmp/chunk_${videoId}_${startTime}_${endTime}_${job.createdAt}.mp3`;
    const duration = endTime - startTime;
    
    console.log(`[Job ${jobId}] Creating chunk: ${startTime}s to ${endTime}s (duration: ${duration}s)`);
    
    await new Promise((resolve, reject) => {
      // Use more compatible FFmpeg options
      const ffmpegCommand = `ffmpeg -ss ${startTime} -i "${fullAudioPath}" -t ${duration} -c:a libmp3lame -b:a 128k -ar 44100 "${chunkPath}" -y`;
      
      exec(ffmpegCommand, { 
        maxBuffer: 100 * 1024 * 1024,
        timeout: 300000 // 5 minute timeout for FFmpeg
      }, (ffmpegError, ffmpegStdout, ffmpegStderr) => {
        // Clean up full audio file
        if (fs.existsSync(fullAudioPath)) {
          try {
            fs.unlinkSync(fullAudioPath);
          } catch (e) {
            // Ignore cleanup errors
          }
        }

        if (ffmpegError) {
          console.error(`[Job ${jobId}] FFmpeg error:`, ffmpegError);
          console.error(`[Job ${jobId}] FFmpeg stderr:`, ffmpegStderr);
          job.status = 'error';
          job.error = `Failed to create audio chunk: ${ffmpegError.message}`;
          reject(ffmpegError);
          return;
        }

        if (!fs.existsSync(chunkPath)) {
          job.status = 'error';
          job.error = 'Audio chunk was not created';
          reject(new Error('Audio chunk was not created'));
          return;
        }
        
        const chunkStats = fs.statSync(chunkPath);
        if (chunkStats.size === 0) {
          try {
            fs.unlinkSync(chunkPath);
          } catch (e) {
            // Ignore cleanup errors
          }
          job.status = 'error';
          job.error = 'Audio chunk is empty';
          reject(new Error('Audio chunk is empty'));
          return;
        }
        
        const fileSizeInMB = (chunkStats.size / (1024 * 1024)).toFixed(2);
        console.log(`[Job ${jobId}] Chunk created successfully: ${fileSizeInMB} MB`);
        
        job.chunkPath = chunkPath;
        job.status = 'completed';
        resolve();
      });
    });
  } else {
    // Full audio ready
    job.status = 'completed';
  }
}

// Get download job status
app.get('/download-status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  
  if (!job) {
    return res.status(404).json({ 
      error: 'Job not found',
      jobId 
    });
  }
  
  const response = {
    jobId: job.jobId,
    status: job.status,
    videoId: job.videoId,
    createdAt: new Date(job.createdAt).toISOString(),
    elapsedSeconds: Math.floor((Date.now() - job.createdAt) / 1000)
  };
  
  if (job.status === 'completed') {
    const filePath = job.chunkPath || job.filePath;
    if (filePath && fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      response.fileSize = stats.size;
      response.fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      response.resultUrl = `/download-result/${jobId}`;
    }
  }
  
  if (job.status === 'error') {
    response.error = job.error;
  }
  
  res.json(response);
});

// Get download result (file)
app.get('/download-result/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  
  if (!job) {
    return res.status(404).json({ 
      error: 'Job not found',
      jobId 
    });
  }
  
  if (job.status === 'processing') {
    return res.status(202).json({ 
      error: 'Job is still processing',
      status: 'processing',
      checkStatusUrl: `/download-status/${jobId}`
    });
  }
  
  if (job.status === 'error') {
    return res.status(500).json({ 
      error: 'Job failed',
      details: job.error
    });
  }
  
  if (job.status !== 'completed') {
    return res.status(400).json({ 
      error: 'Invalid job status',
      status: job.status
    });
  }
  
  // Determine which file to send
  const filePath = job.chunkPath || job.filePath;
  
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ 
      error: 'File not found',
      jobId 
    });
  }
  
  const stats = fs.statSync(filePath);
  if (stats.size === 0) {
    return res.status(500).json({ 
      error: 'File is empty',
      jobId 
    });
  }
  
  // Determine filename
  let filename;
  if (job.chunkPath) {
    filename = `chunk_${job.videoId}_${job.startTime}_${job.endTime}.mp3`;
  } else {
    filename = `audio_${job.videoId}.mp3`;
  }
  
  console.log(`[Job ${jobId}] Sending file: ${filename} (${(stats.size / (1024 * 1024)).toFixed(2)} MB)`);
  
  res.download(filePath, filename, (err) => {
    if (err) {
      console.error(`[Job ${jobId}] Download error:`, err);
    } else {
      console.log(`[Job ${jobId}] File sent successfully`);
      // Clean up file after download
      setTimeout(() => {
        if (filePath && fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
            console.log(`[Job ${jobId}] Cleaned up file: ${filePath}`);
          } catch (e) {
            console.error(`[Job ${jobId}] Error cleaning up file:`, e);
          }
        }
      }, 1000);
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    tmpDir: fs.existsSync('/tmp') ? 'accessible' : 'not accessible',
    activeJobs: jobs.size
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Vimeo Audio Downloader API v2.3.0 running on port ${PORT}`);
  console.log(`Temp directory: ${fs.existsSync('/tmp') ? '/tmp accessible' : '/tmp NOT accessible'}`);
});