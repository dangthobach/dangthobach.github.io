import fs from 'fs';
import path from 'path';

// --- CONFIGURATION ---
const VAULT_PATH = 'C:\\Users\\Admin\\OneDrive\\Documents\\Obsidian Vault';
const CONTENT_PATH = path.resolve('quartz/content');
const IGNORE_LIST = ['.obsidian', '.git', '.trash', '.DS_Store'];
// ---------------------

async function sync() {
  console.log('🚀 Bắt đầu đồng bộ từ Obsidian Vault...');
  console.log(`📂 Nguồn: ${VAULT_PATH}`);
  console.log(`📂 Đích: ${CONTENT_PATH}`);

  try {
    // 1. Kiểm tra nguồn có tồn tại không
    if (!fs.existsSync(VAULT_PATH)) {
      console.error('❌ Lỗi: Không tìm thấy thư mục Obsidian Vault tại đường dẫn đã cấu hình.');
      process.exit(1);
    }

    // 2. Làm sạch thư mục đích
    console.log('🧹 Đang làm sạch thư mục đích...');
    const existingFiles = fs.readdirSync(CONTENT_PATH);
    for (const file of existingFiles) {
      if (file === '.gitkeep') continue;
      const fullPath = path.join(CONTENT_PATH, file);
      fs.rmSync(fullPath, { recursive: true, force: true });
    }

    // 3. Copy nguyên trạng Vault. Không rút gọn wikilink vì basename có thể
    // trùng nhau và làm mất ngữ cảnh thư mục, dẫn đến URL 404 trên Quartz.
    console.log('📂 Đang copy dữ liệu và giữ nguyên đường dẫn wikilink...');
    fs.cpSync(VAULT_PATH, CONTENT_PATH, {
      recursive: true,
      filter: (src) => {
        const basename = path.basename(src);
        return !IGNORE_LIST.includes(basename);
      },
    });

    // 4. Đảm bảo có file index.md
    const indexDest = path.join(CONTENT_PATH, 'index.md');
    if (!fs.existsSync(indexDest)) {
      console.log('📝 Không tìm thấy index.md, đang tạo từ file fallback...');
      const fallbacks = ['Welcome.md', 'HOME.md', 'home.md', 'README.md'];
      let foundFallback = false;
      for (const fallback of fallbacks) {
        const fallbackPath = path.join(CONTENT_PATH, fallback);
        if (fs.existsSync(fallbackPath)) {
          fs.copyFileSync(fallbackPath, indexDest);
          console.log(`✅ Đã tạo index.md từ ${fallback}`);
          foundFallback = true;
          break;
        }
      }
      if (!foundFallback) {
        fs.writeFileSync(indexDest, '---\ntitle: Home\n---\n# Welcome to my Knowledge Base');
        console.log('✅ Đã tạo index.md mặc định.');
      }
    }

    console.log('✅ Đồng bộ hoàn tất!');
    console.log('💡 Bây giờ bạn có thể kiểm tra lại và chạy "git add . && git commit -m \'Sync notes\' && git push"');
  } catch (error) {
    console.error('❌ Có lỗi xảy ra trong quá trình đồng bộ:', error.message);
    process.exitCode = 1;
  }
}

sync();
