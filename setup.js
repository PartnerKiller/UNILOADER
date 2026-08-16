#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CONFIG_FILE = path.join(__dirname, 'config.json');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('====================================================');
console.log('🚀 JAV-Downloader &bull; Installation & Setup');
console.log('====================================================\n');

// Generic path example
const placeholder = process.platform === 'win32' ? 'C:\\Users\\<YourUsername>\\Downloads or C:\\Downloads' : '/home/<username>/Downloads or /var/downloads';

rl.question(`Enter the full path where you want downloads to be saved:\n(Example: ${placeholder})\n> `, (answer) => {
  const dirPath = answer.trim();

  if (!dirPath) {
    console.error('\n❌ Error: Download directory cannot be empty.');
    rl.close();
    process.exit(1);
  }

  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      console.log(`\n📁 Directory created: ${dirPath}`);
    } else {
      console.log(`\n📁 Directory verified: ${dirPath}`);
    }

    const config = {
      downloadDir: path.resolve(dirPath)
    };

    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    console.log(`✅ Configuration saved to ${CONFIG_FILE}`);
    console.log('\n🎉 Setup complete! You can now start the server with: npm start\n');
  } catch (err) {
    console.error(`\n❌ Failed to configure directory: ${err.message}`);
  }

  rl.close();
});
