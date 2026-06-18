const WebSocket = require('ws');
const express = require('express');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// Configuration
const CONFIG = {
  PORT: process.env.PORT || 8083,
  WS_PORT: process.env.WS_PORT || 8083,
  TEMP_CHECK_INTERVAL: 1000, // Check temperature every 1 seconds
  TEMP_EMIT_INTERVAL: 2000, // Emit to clients every 2 seconds
  MAX_CLIENTS: 50
};

// Temperature state
let temperatureData = {
  celsius: 0,
  fahrenheit: 0,
  timestamp: Date.now(),
  isValid: false,
  error: null
};

let wsServer = null;
let tempCheckInterval = null;
let tempEmitInterval = null;
let clientCount = 0;

// Utility functions
function parseTemperature(output) {
  try {
    const match = output.toString().match(/temp=([\d.]+)/);
    if (match && match[1]) {
      // vcgencmd returns °C directly - NO /1000 needed
      const celsius = parseFloat(match[1]);
      const result = {
        celsius: Math.round(celsius * 10) / 10,  // 1 decimal place
        fahrenheit: Math.round((celsius * 9/5 + 32) * 10) / 10,
        timestamp: Date.now(),
        isValid: true,
        error: null,
        source: 'vcgencmd'
      };
      
      // Log temperature changes (only if significant)
      if (Math.abs(result.celsius - temperatureData.celsius) > 0.5) {
        console.log('info', `Temperature changed to ${result.celsius}°C`, {
          temperature: result.celsius,
          delta: result.celsius - temperatureData.celsius
        });
      }
      
      return result;
    }
    return {
      celsius: 0,
      fahrenheit: 0,
      timestamp: Date.now(),
      isValid: false,
      error: 'Invalid temperature format',
      source: 'vcgencmd'
    };
  } catch (error) {
    return {
      celsius: 0,
      fahrenheit: 0,
      timestamp: Date.now(),
      isValid: false,
      error: error.message,
      source: 'vcgencmd'
    };
  }
}

async function getTemperature() {
  try {
    // Try vcgencmd first
    const { stdout: vcgencmdOut, stderr: vcgencmdErr } = await execAsync('vcgencmd measure_temp', {
      timeout: 5000,
      encoding: 'utf8'
    });
    
    console.log('debug', `vcgencmd raw output: "${vcgencmdOut.trim()}"`, { stderr: vcgencmdErr ? vcgencmdErr.trim() : 'none' });
    
    if (vcgencmdErr) {
      console.log('warn', 'vcgencmd failed with stderr', { error: vcgencmdErr });
    }
    
    let newTempData = parseTemperature(vcgencmdOut);
    
    // Fallback to /sys if vcgencmd invalid
    if (!newTempData.isValid) {
      console.log('info', 'vcgencmd invalid, falling back to /sys/thermal');
      const { stdout: sysOut, stderr: sysErr } = await execAsync('cat /sys/class/thermal/thermal_zone0/temp', {
        timeout: 2000,
        encoding: 'utf8'
      });
      
      console.log('debug', `/sys/thermal raw output: "${sysOut.trim()}"`, { stderr: sysErr ? sysErr.trim() : 'none' });
      
      if (sysErr) {
        throw new Error(`Fallback failed: ${sysErr.trim()}`);
      }
      
      const millicelsius = parseInt(sysOut.trim());
      if (!isNaN(millicelsius) && millicelsius > 0) {
        const celsius = millicelsius / 1000;  // /1000 for millicelsius
        newTempData = {
          celsius: Math.round(celsius * 10) / 10,
          fahrenheit: Math.round((celsius * 9/5 + 32) * 10) / 10,
          timestamp: Date.now(),
          isValid: true,
          error: null,
          source: 'sys_thermal'
        };
        log('info', `Fallback temperature read: ${newTempData.celsius}°C from ${millicelsius} millicelsius`);
      } else {
        throw new Error(`Invalid sys temp: ${millicelsius}`);
      }
    } else {
      console.log('debug', `Parsed vcgencmd temp: ${newTempData.celsius}°C`);
    }
    
    temperatureData = newTempData;
    return newTempData;
  } catch (error) {
    console.log('error', `Temperature read failed: ${error.message}`, {
      error: error.message,
      code: error.code,
      signal: error.signal
    });
    
    temperatureData = {
      ...temperatureData,
      isValid: false,
      error: error.message,
      timestamp: Date.now()
    };
    return temperatureData;
  }
}

// WebSocket server setup
function setupWebSocketServer(httpServer) {
  // Create WebSocket server attached to the HTTP server
  wsServer = new WebSocket.Server({ 
    server: httpServer,
    path: '/ws',
    maxPayload: 10 * 1024, // 10KB
    clientTracking: true
  });

  wsServer.on('connection', (ws, req) => {
    clientCount++;
    console.log(`Temperature client connected from ${req.socket.remoteAddress}. Total clients: ${clientCount}`);
    
    // Send current temperature immediately
    ws.send(JSON.stringify({
      type: 'temperature',
      data: temperatureData,
      connectedAt: Date.now()
    }));

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        console.debug('Received from client:', data);
        
        // Handle client requests
        if (data.type === 'request_temperature') {
          ws.send(JSON.stringify({
            type: 'temperature',
            data: temperatureData
          }));
        }
      } catch (error) {
        console.warn('Invalid message from client:', error.message);
      }
    });

    ws.on('close', (code, reason) => {
      clientCount--;
      console.log(`Temperature client disconnected (code: ${code}). Total clients: ${clientCount}`);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error.message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1011, 'Server error');
      }
    });
  });

  wsServer.on('error', (error) => {
    console.error('WebSocket server error:', error.message);
  });

  console.log(`WebSocket temperature server running on ws://0.0.0.0:${CONFIG.WS_PORT}/ws`);
}

// Temperature monitoring
function startTemperatureMonitoring() {
  // Initial temperature read
  getTemperature().then((temp) => {
    console.log(`Initial temperature: ${temp.celsius}°C (${temp.fahrenheit}°F)`);
  });

  // Periodic temperature checks
  tempCheckInterval = setInterval(() => {
    getTemperature();
  }, CONFIG.TEMP_CHECK_INTERVAL);

  // Periodic emissions to clients
  tempEmitInterval = setInterval(() => {
    if (wsServer && clientCount > 0) {
      const message = JSON.stringify({
        type: 'temperature_update',
        data: temperatureData,
        clients: clientCount
      });
      
      let sentCount = 0;
      wsServer.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
          sentCount++;
        }
      });
      
      if (sentCount > 0) {
        console.log(`Emitted temperature to ${sentCount} clients: ${temperatureData.celsius}°C`);
      }
    }
  }, CONFIG.TEMP_EMIT_INTERVAL);
}

function stopTemperatureMonitoring() {
  if (tempCheckInterval) {
    clearInterval(tempCheckInterval);
    tempCheckInterval = null;
  }
  if (tempEmitInterval) {
    clearInterval(tempEmitInterval);
    tempEmitInterval = null;
  }
}

// HTTP server for health checks
const app = express();

app.use(express.json());
app.use(express.static('public')); // Serve static files if needed

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    temperature: temperatureData,
    clients: clientCount,
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// Temperature endpoint (REST API)
app.get('/api/temperature', (req, res) => {
  res.json({
    success: temperatureData.isValid,
    data: temperatureData
  });
});

// CORS headers for WebSocket
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down temperature server...');
  stopTemperatureMonitoring();
  
  if (wsServer) {
    wsServer.close(() => {
      console.log('WebSocket server closed');
    });
  }
  
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  stopTemperatureMonitoring();
  process.exit(0);
});

// Start server
async function startServer() {
  try {
    // Initial temperature read
    await getTemperature();
    
    // Create HTTP server
    const server = app.listen(CONFIG.PORT, '0.0.0.0', () => {
      console.log(`Temperature HTTP server running on http://0.0.0.0:${CONFIG.PORT}`);
    });

    // Setup WebSocket server after HTTP server is ready
    server.on('listening', () => {
      setupWebSocketServer(server);
      startTemperatureMonitoring();
    });

    // Handle server errors
    server.on('error', (error) => {
      if (error.syscall !== 'listen') {
        throw error;
      }

      const bind = typeof CONFIG.PORT === 'string' 
        ? 'Pipe ' + CONFIG.PORT 
        : 'Port ' + CONFIG.PORT;

      // Handle specific listen errors with friendly messages
      switch (error.code) {
        case 'EACCES':
          console.error(`${bind} requires elevated privileges`);
          process.exit(1);
          break;
        case 'EADDRINUSE':
          console.error(`${bind} is already in use`);
          process.exit(1);
          break;
        default:
          throw error;
      }
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer().catch(console.error);