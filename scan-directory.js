const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const readline = require('readline');

// --- НАСТРОЙКИ КОНСОЛИ И ЦВЕТА ---
const R = '\x1b[31m'; const G = '\x1b[32m'; const Y = '\x1b[33m';
const B = '\x1b[34m'; const M = '\x1b[35m'; const C = '\x1b[36m';
const W = '\x1b[37m'; const X = '\x1b[0m';

const HISTORY_FILE = path.join(__dirname, '.report_history.json');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const CONFIG = {
    // Папки, которые полностью игнорируем
    EXCLUDE_DIRS: [
        'node_modules', '.git', 'dist', 'build', '.svn', '.hg',
        '.cache', '__pycache__', 'venv', '.venv', 'env', 'target',
        'out', 'coverage', '.next', '.nuxt', '.output', '.idea',
        '.vscode', '__MACOSX', 'addons', '.godot', 'obj', 'PNG'
    ],

    COLLAPSE_DIRS: [],

    // Файлы, которые даже не показываем в дереве
    IGNORE_FILES_ENDING: ['.import'],

    // Файлы, которые показываем в дереве, но НЕ читаем содержимое
    IGNORE_CONTENT_EXT: [
        '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg',
        '.mp3', '.wav', '.ogg', '.mp4', '.avi', '.mov',
        '.zip', '.rar', '.tar', '.gz', '.7z', '.pck', '.apk',
        '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
        '.pdf', '.doc', '.docx', '.xls', '.xlsx',
        '.ctex', '.md5', '.scn', '.res',
        '.mesh', '.uid', '.mtl', '.glb', '.obj', '.fbx',
        '.ttf', '.otf', '.woff', '.woff2', '.eot', '.blend',
        '.tres', '.material' // Игнорируем материалы и темы
    ],

    TEXT_EXTENSIONS: {
        code: ['.js', '.ts', '.py', '.gd', '.shader', '.glsl'],
        config: ['.json', '.yaml', '.yml', '.toml', '.xml', '.ini', '.cfg', '.conf'],
        markup: ['.html', '.css', '.md', '.txt', '.tscn', '.godot'],
        scripts: ['.sh', '.bat', '.cmd'],
        data: ['.csv']
    },

    MAX_FILE_SIZE_CODE: 2 * 1024 * 1024, // 2MB
    MAX_LINES_CODE: 5000,
    MAX_LINE_LENGTH: 150,
    MIN_FILE_SIZE_SHOW: 10,
    MAX_DEPTH: 20
};

// Глобальная переменная для статистики, но теперь мы будем ее обнулять при каждом старте
let projectStats;

// --- ФУНКЦИИ ИСТОРИИ ПУТЕЙ ---
async function loadHistory() {
    try {
        if (fsSync.existsSync(HISTORY_FILE)) {
            const data = await fs.readFile(HISTORY_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) { /* Игнорируем ошибку чтения */ }
    return [];
}

async function saveHistory(historyArray) {
    try {
        await fs.writeFile(HISTORY_FILE, JSON.stringify(historyArray, null, 2), 'utf8');
    } catch (e) { console.log(`${R}Не удалось сохранить историю путей.${X}`); }
}

function addToHistory(historyArray, newPath) {
    const absolutePath = path.resolve(newPath);
    // Удаляем, если уже есть, чтобы переместить наверх
    historyArray = historyArray.filter(p => p !== absolutePath);
    historyArray.unshift(absolutePath); // Добавляем в начало
    if (historyArray.length > 3) historyArray.pop(); // Оставляем только 3
    return historyArray;
}

// --- УТИЛИТЫ ---
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

function getFileType(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    for (const [category, exts] of Object.entries(CONFIG.TEXT_EXTENSIONS)) {
        if (exts.includes(ext)) return category;
    }
    if (CONFIG.IGNORE_CONTENT_EXT.includes(ext)) return 'binary';
    return 'other';
}

// --- УМНЫЙ ПАРСЕР СЦЕН GODOT (.tscn) ---
function filterGodotScene(content) {
    const lines = content.split('\n');
    const filteredLines = [];
    let insideSubResource = false;

    // Регулярка для визуального и физического мусора, который не нужен ИИ
    const noiseRegex = /^(transform|position|rotation|scale|layout_mode|anchor_|offset_|grow_|theme|custom_minimum_size|size_flags_|texture|mesh|material|shape|visible|modulate|self_modulate|metadata\/_)/;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trimEnd();
        let trimmed = line.trim();

        if (trimmed === '') continue;

        // Определяем начало блоков
        if (trimmed.startsWith('[')) {
            // Игнорируем блоки sub_resource и resource (это 3D меши, материалы, кривые)
            if (trimmed.startsWith('[sub_resource') || trimmed.startsWith('[resource]')) {
                insideSubResource = true;
                continue;
            }
            // Для ext_resource оставляем ТОЛЬКО скрипты (шрифты и текстуры выкидываем)
            else if (trimmed.startsWith('[ext_resource')) {
                if (!trimmed.includes('type="Script"')) {
                    continue;
                }
            }

            // Если дошли до [node] или [connection], мы вышли из ресурсов
            insideSubResource = false;
            filteredLines.push(line);
            continue;
        }

        // Если мы внутри 3D меша или материала - пропускаем всё
        if (insideSubResource) continue;

        // Если это настройка ноды, проверяем, не мусор ли это
        if (noiseRegex.test(trimmed)) {
            continue;
        }

        // Защита от гигантских массивов (если вдруг просочились)
        if (trimmed.match(/(Packed\w+Array|Pool\w+Array)\s*\(/i)) {
            filteredLines.push(`    [... Массив данных скрыт ...]`);
            continue;
        }

        filteredLines.push(line);
    }

    return filteredLines;
}

// --- СКАНЕР ---
async function scanDirectory(dirPath, depth = 0, output = [], basePath = dirPath) {
    if (depth > CONFIG.MAX_DEPTH) return { output, files: [] };

            try {
                const entries = await fs.readdir(dirPath, { withFileTypes: true });

                // Сортировка: папки потом файлы, по алфавиту
                entries.sort((a, b) => {
                    if (a.isDirectory() && !b.isDirectory()) return -1;
                    if (!a.isDirectory() && b.isDirectory()) return 1;
                    return a.name.localeCompare(b.name);
                });

                let allFiles = [];

                for (let i = 0; i < entries.length; i++) {
                    const entry = entries[i];

                    // Игнорируем .import и другие файлы из черного списка
                    if (CONFIG.IGNORE_FILES_ENDING.some(ending => entry.name.endsWith(ending))) {
                        continue;
                    }

                    const fullPath = path.join(dirPath, entry.name);
                    const relativePath = path.relative(basePath, fullPath);
                    const indent = '  '.repeat(depth);
                    const isLast = i === entries.length - 1;
                    const prefix = indent + (isLast ? '└──' : '├──');

                    if (entry.isDirectory()) {
                        projectStats.dirs.total++;
                        if (CONFIG.EXCLUDE_DIRS.includes(entry.name)) {
                            // output.push(`${prefix} ${R}${entry.name}${X} [ИГНОР]`);
                            continue;
                        }
                        output.push(`${prefix} ${B}${entry.name}${X} [DIR]`);
                        const result = await scanDirectory(fullPath, depth + 1, [], basePath);
                        output.push(...result.output);
                        allFiles.push(...result.files);
                        continue;
                    }

                    const stats = await fs.stat(fullPath);
                    projectStats.size += stats.size;
                    projectStats.files.total++;

                    const fileType = getFileType(entry.name);
                    const ext = path.extname(entry.name).toLowerCase();
                    const isCodeFile = fileType === 'code' || fileType === 'scripts';
                    const isSceneFile = ext === '.tscn';

                    projectStats.files.byType[fileType] = (projectStats.files.byType[fileType] || 0) + 1;
                    if (isCodeFile) projectStats.codeFiles++;
            else if (fileType === 'binary') projectStats.assetFiles++;

            let typeLabel = fileType.toUpperCase();
                    let lineColor = fileType === 'code' ? G : fileType === 'markup' ? M : fileType === 'binary' ? W : Y;
                    output.push(`${prefix} ${lineColor}${entry.name}${X} [${typeLabel}] | ${formatBytes(stats.size)}`);
                    allFiles.push(relativePath);

                    // ЧТЕНИЕ СОДЕРЖИМОГО
                    const shouldShowContent = !CONFIG.IGNORE_CONTENT_EXT.includes(ext) && stats.size <= CONFIG.MAX_FILE_SIZE_CODE && stats.size > CONFIG.MIN_FILE_SIZE_SHOW;

                    if (shouldShowContent) {
                        try {
                            const content = await fs.readFile(fullPath, 'utf8');
                            let lines = [];

                            if (isSceneFile) {
                                lines = filterGodotScene(content); // Применяем наш хирургический парсер
                            } else {
                                lines = content.split('\n').filter(l => l.trim().length > 0);
                                if (isCodeFile) projectStats.linesOfCode += lines.length;
                            }

                            const showLines = Math.min(lines.length, isSceneFile ? 500 : CONFIG.MAX_LINES_CODE);
                            const connector = isLast ? ' ' : '│';

                            if (showLines > 0) {
                                output.push(`${indent}${connector}   ${Y}└──${X} КОНТЕНТ:`);
                                output.push(`${indent}${connector}       ${Y}┌${X}${'─'.repeat(50)}`);

                                for (let j = 0; j < showLines; j++) {
                                    let cl = lines[j].replace(/\t/g, '    ');
                                    if (!isCodeFile && !isSceneFile && cl.length > CONFIG.MAX_LINE_LENGTH) {
                                        cl = cl.slice(0, CONFIG.MAX_LINE_LENGTH) + '...';
                                    }
                                    const color = cl.trim().startsWith('#') ? Y : W;
                                    output.push(`${indent}${connector}       ${Y}│${X} ${color}${cl}${X}`);
                                }

                                if (lines.length > showLines) {
                                    output.push(`${indent}${connector}       ${Y}│${X} ${C}...[скрыто ${lines.length - showLines} строк]${X}`);
                                }
                                output.push(`${indent}${connector}       ${Y}└${X}${'─'.repeat(50)}`);
                            }
                        } catch (err) {
                            const connector = isLast ? ' ' : '│';
                            output.push(`${indent}${connector}       ${R}[Ошибка чтения]${X}`);
                        }
                    }
                }
                return { output, files: allFiles };
            } catch (error) {
                output.push(`[${R}Ошибка: ${error.message}${X}]`);
                return { output, files: [] };
            }
}

async function start() {
    // Обнуляем статистику ПЕРЕД каждым новым сканированием
    projectStats = {
        files: { total: 0, byType: {} }, dirs: { total: 0 },
        size: 0, linesOfCode: 0, codeFiles: 0, assetFiles: 0
    };

    console.clear();
    console.log(`${C}🚀 УНИВЕРСАЛЬНЫЙ ГЕНЕРАТОР ОТЧЕТОВ :)${X}\n`);

    let history = await loadHistory();

    if (history.length > 0) {
        console.log(`${Y}Последние папки:${X}`);
        history.forEach((p, idx) => {
            console.log(`  ${G}${idx + 1}${X}: ${p}`);
        });
        console.log(`  ${G}0${X}: Ввести другой путь вручную`);
        console.log('');
    } else {
        console.log(`Введите путь к папке (или нажмите Enter для текущей директории).`);
    }

    rl.question(`${Y}> Ваш выбор (цифра или путь): ${X}`, async (input) => {
        let targetPath = input.trim();

        // Обработка выбора из истории
        if (history.length > 0 && /^[1-3]$/.test(targetPath)) {
            const idx = parseInt(targetPath) - 1;
            if (history[idx]) {
                targetPath = history[idx];
            } else {
                console.log(`${R}Неверный номер.${X}`);
                // Даем шанс попробовать снова, а не закрываем
                setTimeout(start, 1500);
                return;
            }
        } else if (targetPath === '0') {
            targetPath = await new Promise(resolve => {
                rl.question(`${Y}> Введите полный путь к папке: ${X}`, ans => resolve(ans.trim()));
            });
        }

        if (!targetPath) targetPath = '.';

        try {
            const stats = await fs.stat(targetPath);
            if (!stats.isDirectory()) throw new Error("Это не папка");
        } catch (e) {
            console.log(`${R}❌ Ошибка: Путь не найден или это не папка (${targetPath})${X}`);
            setTimeout(start, 2000); // Возвращаем в меню через пару секунд
            return;
        }

        console.log(`\n${C}⏳ Сканирую: ${targetPath}...${X}`);

        // Сохраняем в историю
        history = addToHistory(history, targetPath);
        await saveHistory(history);

        // Генерация
        const { output } = await scanDirectory(targetPath);

        // Формируем безопасное имя для файла
        const folderName = path.basename(path.resolve(targetPath));
        const safeFolderName = folderName.replace(/[^a-zA-Z0-9А-Яа-яЁё_-]/g, '_');

        let report = [];
        report.push('═'.repeat(80));
        report.push(`📁 ОТЧЕТ О ПАПКЕ: ${folderName}`);
        report.push(`📅 Создан: ${new Date().toLocaleString()}`);
        report.push('═'.repeat(80));
        report.push(...output);

        report.push('\n📊 СВОДКА:');
        report.push('═'.repeat(40));
        report.push(`• Общий размер: ${formatBytes(projectStats.size)}`);
        report.push(`• Директорий: ${projectStats.dirs.total}`);
        report.push(`• Файлов (всего): ${projectStats.files.total}`);
        report.push(`• Файлов кода/скриптов: ${projectStats.codeFiles}`);
        report.push(`• Строк чистого кода: ${projectStats.linesOfCode}`);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const reportFileName = `report_${safeFolderName}_${timestamp}.txt`;

        const cleanReport = report.join('\n').replace(/\x1b\[\d+m/g, '');
        await fs.writeFile(reportFileName, cleanReport, 'utf8');

        console.log(`\n${G}✅ Отчет сохранен: ${reportFileName}${X}`);
        if (projectStats.linesOfCode > 0) {
            console.log(`${C}Строк чистого кода: ${projectStats.linesOfCode}${X}`);
        }

        // --- ВОТ ТУТ НОВАЯ ЛОГИКА ВОЗВРАТА В МЕНЮ ---
        rl.question(`\n${Y}> Нажми Enter, чтобы вернуться в меню (или введи 'q' для выхода): ${X}`, (answer) => {
            if (answer.trim().toLowerCase() === 'q') {
                console.log(`${C}Удачного кодинга! 👋${X}`);
                rl.close();
            } else {
                start(); // Запускаем заново
            }
        });
    });
}

// Поехали
start();
