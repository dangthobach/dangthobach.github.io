import fs from 'fs';
import path from 'path';

// --- CONFIGURATION ---
const VAULT_PATH = 'C:\\Users\\Admin\\OneDrive\\Documents\\Obsidian Vault';
const CONTENT_PATH = path.resolve('quartz/content');
const IGNORE_LIST = ['.obsidian', '.git', '.trash', '.DS_Store'];
// ---------------------

/**
 * Chuyển đổi Obsidian Image Links ![[image.png|alias]] thành Standard Markdown ![](image.png)
 * @param {string} content Nội dung markdown
 * @returns {string} Nội dung đã được chuyển đổi
 */
function convertObsidianImageLinks(content) {
  // Regex khớp với ![[path/to/image.png|alias]]
  // Group 1: Đường dẫn ảnh
  // Group 2: Alias (tuỳ chọn)
  return content.replace(/!\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g, (match, filePath) => {
    let cleanPath = filePath.trim();
    
    // Nếu có leading slash (/) thì bỏ đi để Quartz dễ resolve theo shortest path
    if (cleanPath.startsWith('/')) {
      cleanPath = cleanPath.substring(1);
    }
    
    // Trả về định dạng Markdown tiêu chuẩn
    // Quartz CrawlLinks plugin sẽ tự resolve shortest path nếu được cấu hình
    return `![](${cleanPath})`;
  });
}

/**
 * Đệ quy duyệt và xử lý các file markdown
 */
function processMarkdownFiles(dir) {
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      // Bỏ qua các thư mục đặc biệt nếu cần, nhưng ở đây ta quét hết content
      processMarkdownFiles(fullPath);
    } else if (file.endsWith('.md')) {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const newContent = convertObsidianImageLinks(content);
        
        if (content !== newContent) {
          fs.writeFileSync(fullPath, newContent, 'utf8');
          console.log(`✨ Đã xử lý ảnh trong: ${path.relative(CONTENT_PATH, fullPath)}`);
        }
      } catch (err) {
        console.error(`❌ Lỗi khi xử lý file ${fullPath}:`, err.message);
      }
    }
  }
}

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

    // 3. Thực hiện copy
    console.log('📂 Đang copy dữ liệu...');
    fs.cpSync(VAULT_PATH, CONTENT_PATH, {
      recursive: true,
      filter: (src) => {
        const basename = path.basename(src);
        return !IGNORE_LIST.includes(basename);
      }
    });

    // 4. Xử lý Markdown Links sau khi copy
    // console.log('🔄 Đang chuyển đổi Obsidian Image Links...');
    // processMarkdownFiles(CONTENT_PATH);

    // 5. Đảm bảo có file index.md
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
  }
}

sync();
