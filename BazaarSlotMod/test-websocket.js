const WebSocket = require('ws');

// WebSocket URL for Coflnet
const WS_URL = 'wss://sky.coflnet.com/modsocket';

console.log('Connecting to Coflnet WebSocket...');
console.log('URL:', WS_URL);
console.log('-----------------------------------\n');

const ws = new WebSocket(WS_URL);

ws.on('open', function open() {
    console.log('✓ Connected to Coflnet WebSocket successfully!\n');
    
    // Test 1: Send /cofl getbazaar command
    console.log('Test 1: Sending /cofl getbazaar command...');
    const getbazaarCommand = {
        type: 'getbazaar',
        data: JSON.stringify('')
    };
    ws.send(JSON.stringify(getbazaarCommand));
    console.log('Sent:', JSON.stringify(getbazaarCommand, null, 2));
    console.log('-----------------------------------\n');
    
    // Test 2: After 5 seconds, send getbazaarflips command
    setTimeout(() => {
        console.log('Test 2: Sending /cofl getbazaarflips command...');
        const getbazaarflipsCommand = {
            type: 'getbazaarflips',
            data: JSON.stringify('')
        };
        ws.send(JSON.stringify(getbazaarflipsCommand));
        console.log('Sent:', JSON.stringify(getbazaarflipsCommand, null, 2));
        console.log('-----------------------------------\n');
    }, 5000);
    
    // Close connection after 30 seconds
    setTimeout(() => {
        console.log('Closing connection...');
        ws.close();
    }, 30000);
});

ws.on('message', function incoming(data) {
    console.log('Received message:');
    console.log('Raw data:', data.toString());
    
    try {
        const parsed = JSON.parse(data);
        console.log('Parsed JSON:', JSON.stringify(parsed, null, 2));
        
        // Check message type
        if (parsed.type === 'getbazaar' || parsed.type === 'getbazaarflips') {
            console.log('\n🎯 BAZAAR FLIP DATA RECEIVED!');
            console.log('Type:', parsed.type);
            console.log('Data:', JSON.stringify(parsed.data, null, 2));
        }
    } catch (e) {
        console.log('Could not parse as JSON:', e.message);
    }
    console.log('-----------------------------------\n');
});

ws.on('error', function error(err) {
    console.error('❌ WebSocket error:', err.message);
    console.error('Stack:', err.stack);
});

ws.on('close', function close(code, reason) {
    console.log('\nWebSocket connection closed');
    console.log('Code:', code);
    console.log('Reason:', reason.toString() || 'No reason provided');
});

// Handle process termination
process.on('SIGINT', () => {
    console.log('\n\nReceived SIGINT, closing connection...');
    ws.close();
    process.exit(0);
});
