import { Jimp } from 'jimp';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const inputPath = resolve(__dirname, '../src/assets/profile-pic.jpg');
const tempPath = resolve(__dirname, '../src/assets/profile-pic-optimized.jpg');

async function main() {
  try {
    console.log('Optimizing profile picture...');
    const image = await Jimp.read(inputPath);
    
    console.log(`Original dimensions: ${image.width}x${image.height}`);
    
    // Resize to width 450px, maintaining aspect ratio
    image.resize({ w: 450 });
    
    // Write out the optimized image as JPEG
    await image.write(tempPath);
    
    // Replace the original file
    fs.copyFileSync(tempPath, inputPath);
    fs.unlinkSync(tempPath);
    
    const stats = fs.statSync(inputPath);
    console.log(`Successfully optimized. New file size: ${(stats.size / 1024).toFixed(2)} KB`);
  } catch (error) {
    console.error('Error during image optimization:', error);
  }
}

main();
