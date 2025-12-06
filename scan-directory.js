const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');

const R = '\x1b[31m';
const G = '\x1b[32m';
const Y = '\x1b[33m';
const B = '\x1b[34m';
const C = '\x1b[36m';
const X = '\x1b[0m';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const CONFIG = {
    EXCLUDE_DIRS: [
        'node_modules', '.git', 'dist', 'build', '.svn', '.hg',
        '.cache', '__pycache__', 'venv', '.venv', 'env', 'target',
        'out', 'coverage', '.next', '.nuxt', '.output', '.idea',
        '.vscode', '__MACOSX'
    ],

    COLLAPSE_DIRS: ['.godot'],

    IGNORE_CONTENT_EXT: [
        '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg',
        '.mp3', '.wav', '.ogg', '.mp4', '.avi', '.mov',
        '.zip', '.rar', '.tar', '.gz', '.7z',
        '.exe', '.dll', '.so', '.dylib',
        '.pdf', '.doc', '.docx', '.xls', '.xlsx',
        '.ctex', '.md5', '.scn', '.res', '.import',
        '.tres', '.tscn', '.mesh', '.cfg', '.uid',
        '.mtl', '.glb', '.obj', '.tres'
    ],

    TEXT_EXTENSIONS: {
        code: ['.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.cpp', '.c', '.h', '.hpp',
        '.go', '.rs', '.swift', '.kt', '.dart', '.php', '.rb', '.pl', '.lua',
        '.cs', '.vb', '.gd'],
        config: ['.json', '.yaml', '.yml', '.toml', '.xml', '.ini', '.cfg', '.conf',
        '.properties', '.env', '.editorconfig', '.gitignore', '.gitattributes'],
        markup: ['.html', '.htm', '.css', '.scss', '.sass', '.less',
        '.md', '.markdown', '.rst', '.txt'],
        scripts: ['.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd'],
        data: ['.sql', '.graphql', '.gql', '.proto', '.csv', '.tsv']
    },

    MAX_FILE_SIZE: 512 * 1024,
    MAX_LINES: 500,
    MIN_FILE_SIZE_SHOW: 100,
    GROUP_BY_TYPE: true,
    SHOW_SUMMARY: true,
    MAX_DEPTH: 20,
    BATCH_SIZE: 50
};

function resetStats() {
    return {
        files: { total: 0, byType: {} },
        dirs: { total: 0 },
        size: 0,
        fileTypes: new Set(),
        projectType: 'Неизвестный',
        engineInfo: {},
        codeFiles: 0,
        configFiles: 0,
        assetFiles: 0,
        ignoredFiles: 0,
        linesOfCode: 0,
        scanDuration: 0,
        scannedFiles: 0,
        scannedDirs: 0,
        scannedSymlinks: 0
    };
}

let projectStats = resetStats();
const fileCache = new Map();
const statsCache = new Map();

async function getFileStats(filePath) {
    if (statsCache.has(filePath)) {
        return statsCache.get(filePath);
    }

    try {
        const stats = await fs.stat(filePath);
        const result = {
            type: stats.isDirectory() ? 'DIR' : stats.isFile() ? 'FILE' :
            stats.isSymbolicLink() ? 'SYMLINK' : 'OTHER',
            size: stats.size,
            permissions: stats.mode.toString(8).slice(-3),
            modified: stats.mtime.toISOString().split('T')[0]
        };
        statsCache.set(filePath, result);
        return result;
    } catch (error) {
        const result = { error: error.message };
        statsCache.set(filePath, result);
        return result;
    }
}

function getFileType(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    const baseName = path.basename(fileName).toLowerCase();

    if (baseName === 'dockerfile') return 'config';
    if (baseName === 'makefile') return 'config';
    if (baseName === 'readme.md' || baseName === 'license') return 'markup';

    for (const [category, exts] of Object.entries(CONFIG.TEXT_EXTENSIONS)) {
        if (exts.includes(ext)) return category;
    }

    if (CONFIG.IGNORE_CONTENT_EXT.includes(ext)) return 'binary';

    return 'other';
}

// Унифицированное чтение с кэшированием
async function readFileContentAndCount(filePath) {
    if (fileCache.has(filePath)) {
        return fileCache.get(filePath);
    }

    try {
        const content = await fs.readFile(filePath, 'utf8');
        const lines = content.split('\n');
        const nonEmptyLines = lines.filter(line => line.trim().length > 0).length;

        const result = { content, lineCount: nonEmptyLines };
        fileCache.set(filePath, result);
        return result;
    } catch {
        const result = { content: '[Ошибка чтения файла]', lineCount: 0 };
        fileCache.set(filePath, result);
        return result;
    }
}

function detectProjectType(files) {
    const fileSet = new Set(files.map(f => path.basename(f).toLowerCase()));

    if (fileSet.has('project.godot') || files.some(f => f.endsWith('.gd'))) return 'Godot';
    if (fileSet.has('package.json')) return 'Node.js';
    if (fileSet.has('requirements.txt') || fileSet.has('setup.py') || fileSet.has('pyproject.toml')) return 'Python';
    if (fileSet.has('cargo.toml')) return 'Rust';
    if (fileSet.has('pom.xml') || fileSet.has('build.gradle')) return 'Java';
    if (files.some(f => f.endsWith('.csproj'))) return '.NET';
    if (fileSet.has('composer.json')) return 'PHP';
    if (fileSet.has('go.mod')) return 'Go';
    if (files.some(f => f.endsWith('.cpp') || f.endsWith('.c') || f.endsWith('.h'))) return 'C/C++';
    if (fileSet.has('gemfile')) return 'Ruby';
    if (files.some(f => f.endsWith('.swift'))) return 'Swift';
    if (files.some(f => f.endsWith('.kt') || f.endsWith('.kts'))) return 'Kotlin';

    return 'Неизвестный';
}

async function getEngineInfo(files, projectType, dirPath) {
    const info = {};

    switch (projectType) {
        case 'Godot':
            info.engine = 'Godot Engine';
            info.version = files.some(f => f.includes('project.godot')) ? '4.x' : 'Unknown';
            info.features = [];
            if (files.some(f => f.endsWith('.tscn'))) info.features.push('Сцены');
            if (files.some(f => f.endsWith('.gd'))) info.features.push('Скрипты GDScript');
            if (files.some(f => f.endsWith('.png') || f.endsWith('.glb') || f.endsWith('.obj')))
                info.features.push('Ассеты');
            break;

        case 'Node.js':
            info.engine = 'Node.js';
            try {
                const pkgPath = path.join(dirPath, 'package.json');
                const data = await fs.readFile(pkgPath, 'utf8');
                const pkg = JSON.parse(data);
                info.version = pkg.engines?.node || 'Unknown';
            } catch {
                info.version = 'Unknown';
            }
            break;

        case 'Python':
            info.engine = 'Python';
            if (files.some(f => f.endsWith('requirements.txt'))) {
                info.features = ['Requirements'];
            }
            break;
    }

    return info;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

function formatDuration(ms) {
    if (ms < 1000) return `${ms}мс`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}с`;
    return `${(ms / 60000).toFixed(2)}м`;
}

async function scanDirectory(dirPath, depth = 0, output = [], basePath = dirPath) {
    if (depth > CONFIG.MAX_DEPTH) {
        output.push(`${'  '.repeat(depth)}[Достигнута максимальная глубина рекурсии: ${CONFIG.MAX_DEPTH}]`);
        return { output, files: [] };
    }

    try {
        const stat = await fs.stat(dirPath);
        if (!stat.isDirectory()) {
            output.push(`[Путь не является директорией: ${dirPath}]`);
            return { output, files: [] };
        }

        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        let allFiles = [];

        for (let i = 0; i < entries.length; i += CONFIG.BATCH_SIZE) {
            const batch = entries.slice(i, i + CONFIG.BATCH_SIZE);

            const batchResults = await Promise.all(batch.map(async (entry, batchIndex) => {
                const entryOutput = [];
                const fullPath = entry.path || path.join(dirPath, entry.name); // ← используем entry.path, если доступен
                const relativePath = path.relative(basePath, fullPath);
                const indent = '  '.repeat(depth);
                const isLast = (i + batchIndex) === entries.length - 1;
                const prefix = indent + (isLast ? '└──' : '├──');
                const entryFiles = [];

                if (entry.isSymbolicLink()) {
                    projectStats.scannedSymlinks++;
                    entryOutput.push(`${prefix} ${entry.name} [SYMLINK]`);
                    return { output: entryOutput, files: [] };
                }

                if (entry.isDirectory()) {
                    projectStats.scannedDirs++;
                    projectStats.dirs.total++;

                    if (CONFIG.EXCLUDE_DIRS.includes(entry.name)) {
                        entryOutput.push(`${prefix} ${entry.name} [DIR - ИСКЛЮЧЕН]`);
                        return { output: entryOutput, files: [] };
                    }

                    const shouldCollapse = CONFIG.COLLAPSE_DIRS.includes(entry.name);
                    if (shouldCollapse) {
                        let collapsedSize = 0;
                        let collapsedFiles = 0;

                        async function countCollapsed(dir) {
                            try {
                                const items = await fs.readdir(dir, { withFileTypes: true });
                                for (const item of items) {
                                    const itemPath = item.path || path.join(dir, item.name);
                                    if (item.isSymbolicLink()) continue;

                                    if (item.isDirectory()) {
                                        await countCollapsed(itemPath);
                                    } else {
                                        collapsedFiles++;
                                        entryFiles.push(path.relative(basePath, itemPath));
                                        try {
                                            const stats = await fs.stat(itemPath);
                                            collapsedSize += stats.size;
                                        } catch {}
                                    }
                                }
                            } catch {}
                        }

                        await countCollapsed(fullPath);
                        entryOutput.push(`${prefix} ${entry.name} [DIR - СВЕРНУТО] | Файлов: ${collapsedFiles} | Размер: ${formatBytes(collapsedSize)}`);
                        return { output: entryOutput, files: entryFiles };
                    }

                    entryOutput.push(`${prefix} ${entry.name} [DIR]`);
                    const result = await scanDirectory(fullPath, depth + 1, [], basePath);
                    entryOutput.push(...result.output);
                    return { output: entryOutput, files: result.files };
                }

                // Файл
                projectStats.scannedFiles++;
                const stats = await getFileStats(fullPath);

                if (stats.error) {
                    entryOutput.push(`${prefix} ${entry.name} [ОШИБКА: ${stats.error}]`);
                    return { output: entryOutput, files: [relativePath] };
                }

                projectStats.size += stats.size;
                projectStats.files.total++;

                const fileType = getFileType(entry.name);
                projectStats.files.byType[fileType] = (projectStats.files.byType[fileType] || 0) + 1;
                projectStats.fileTypes.add(path.extname(entry.name));

                if (['code', 'scripts'].includes(fileType)) {
                    projectStats.codeFiles++;
                    const { lineCount } = await readFileContentAndCount(fullPath);
                    projectStats.linesOfCode += lineCount;
                } else if (fileType === 'config') {
                    projectStats.configFiles++;
                } else if (fileType === 'binary') {
                    projectStats.assetFiles++;
                } else {
                    projectStats.ignoredFiles++;
                }

                const typeLabels = {
                    'code': 'КОД', 'config': 'КОНФИГ', 'markup': 'ДОКУМ',
                    'scripts': 'СКРИПТ', 'data': 'ДАННЫЕ', 'binary': 'БИНАРНЫЙ'
                };

                const typeLabel = typeLabels[fileType] || 'ФАЙЛ';
                let line = `${prefix} ${entry.name} [${typeLabel}]`;
                line += ` | Размер: ${formatBytes(stats.size)}`;
                line += ` | Права: ${stats.permissions}`;
                line += ` | Изменен: ${stats.modified}`;

                entryOutput.push(line);
                entryFiles.push(relativePath);

                const shouldShowContent = !CONFIG.IGNORE_CONTENT_EXT.some(ext =>
                    entry.name.toLowerCase().endsWith(ext)
                ) && stats.size <= CONFIG.MAX_FILE_SIZE && stats.size > CONFIG.MIN_FILE_SIZE_SHOW;

                if (shouldShowContent) {
                    const { content } = await readFileContentAndCount(fullPath);
                    if (content && content.trim()) {
                        const lines = content.split('\n');
                        const showLines = Math.min(lines.length, CONFIG.MAX_LINES);

                        entryOutput.push(`${indent}${isLast ? ' ' : '│'}   └── СОДЕРЖИМОЕ:`);
                        entryOutput.push(`${indent}${isLast ? ' ' : '│'}       ┌${'─'.repeat(70)}`);

                        for (let j = 0; j < showLines; j++) {
                            entryOutput.push(`${indent}${isLast ? ' ' : '│'}       │ ${lines[j]}`);
                        }

                        if (lines.length > CONFIG.MAX_LINES) {
                            entryOutput.push(`${indent}${isLast ? ' ' : '│'}       │ ...[показано ${showLines} из ${lines.length} строк]`);
                        }

                        entryOutput.push(`${indent}${isLast ? ' ' : '│'}       └${'─'.repeat(70)}`);
                    }
                }

                return { output: entryOutput, files: entryFiles };
            }));

            for (const result of batchResults) {
                output.push(...result.output);
                if (result.files && Array.isArray(result.files)) {
                    allFiles.push(...result.files);
                }
            }
        }

        return { output, files: allFiles };
    } catch (error) {
        output.push(`[Ошибка сканирования ${dirPath}: ${error.message}]`);
        return { output, files: [] };
    }
}

function generateProjectSummary(allFiles) {
    const summary = [];

    summary.push('\n📊 СВОДКА ПРОЕКТА:');
    summary.push('═'.repeat(70));
    summary.push(`• Тип проекта: ${projectStats.projectType}`);
    summary.push(`• Общий размер: ${formatBytes(projectStats.size)}`);
    summary.push(`• Директорий: ${projectStats.dirs.total}`);
    summary.push(`• Файлов: ${projectStats.files.total}`);
    if (projectStats.scannedSymlinks > 0) {
        summary.push(`• Симлинков: ${projectStats.scannedSymlinks}`);
    }
    summary.push(`• Строк кода: ${projectStats.linesOfCode}`);

    if (projectStats.engineInfo.engine) {
        summary.push(`• Движок: ${projectStats.engineInfo.engine} ${projectStats.engineInfo.version || ''}`);
        if (projectStats.engineInfo.features) {
            summary.push(`• Функции: ${projectStats.engineInfo.features.join(', ')}`);
        }
    }

    const keyFiles = allFiles
        .filter(file => {
            const name = file.toLowerCase();
            const isInCollapsed = CONFIG.COLLAPSE_DIRS.some(collapsed =>
                name.includes(`/${collapsed}/`) || name.startsWith(`${collapsed}/`)
            );
            if (isInCollapsed) return false;

            const importantFiles = [
                'package.json', 'cargo.toml', 'pom.xml', 'build.gradle',
                'composer.json', 'go.mod', 'requirements.txt', 'setup.py',
                'gemfile', 'dockerfile', 'makefile', '.gitignore',
                'readme.md', 'license'
            ];

            const importantDirs = ['src/', 'lib/', 'app/', 'source/', 'scripts/', 'scenes/'];
            const isInImportantDir = importantDirs.some(dir => name.startsWith(dir));

            return importantFiles.includes(path.basename(name).toLowerCase()) ||
                isInImportantDir ||
                name === 'project.godot' ||
                name.includes('main.') ||
                name.includes('app.') ||
                name.includes('index.');
        })
        .slice(0, 20);

    if (keyFiles.length > 0) {
        summary.push('\n🔍 КЛЮЧЕВЫЕ ФАЙЛЫ:');
        summary.push('─'.repeat(40));
        keyFiles.forEach(file => {
            const fileType = getFileType(file);
            const typeLabels = {
                'code': '📝', 'config': '⚙️', 'markup': '📄',
                'scripts': '🐚', 'data': '📊', 'binary': '📦'
            };
            const emoji = typeLabels[fileType] || '📄';
            summary.push(`• ${emoji} ${file}`);
        });
    }

    if (CONFIG.GROUP_BY_TYPE && Object.keys(projectStats.files.byType).length > 0) {
        summary.push('\n📦 СТАТИСТИКА ПО ТИПАМ:');
        summary.push('─'.repeat(40));

        const typeDisplay = {
            'code': 'Файлы кода',
            'config': 'Конфигурации',
            'markup': 'Документация',
            'scripts': 'Скрипты',
            'data': 'Данные',
            'binary': 'Ресурсы',
            'other': 'Прочие'
        };

        Object.entries(projectStats.files.byType)
            .sort((a, b) => b[1] - a[1])
            .forEach(([type, count]) => {
                summary.push(`• ${typeDisplay[type] || type}: ${count} файлов`);
            });
    }

    return summary.join('\n');
}

async function generateReport(dirPath) {
    console.log(`\n${C}🔍 Сканирование: ${dirPath}${X}`);
    console.log('─'.repeat(80));

    const scanStartTime = Date.now();
    projectStats = resetStats();
    fileCache.clear();
    statsCache.clear();

    try {
        const stat = await fs.stat(dirPath);
        if (!stat.isDirectory()) {
            return { report: `❌ Путь не является директорией: ${dirPath}`, stats: projectStats };
        }

        const report = [];
        report.push('='.repeat(80));
        report.push(`📁 ОТЧЕТ О ПРОЕКТЕ: ${path.basename(dirPath) || dirPath}`);
        report.push(`📅 Создан: ${new Date().toLocaleString()}`);
        report.push(`📍 Путь: ${dirPath}`);
        report.push('='.repeat(80));

        report.push('📂 СОДЕРЖИМОЕ ПРОЕКТА:');
        const { output: content, files: allFiles } = await scanDirectory(dirPath, 0, [], dirPath);
        report.push(...content);

        projectStats.projectType = detectProjectType(allFiles);
        projectStats.engineInfo = await getEngineInfo(allFiles, projectStats.projectType, dirPath);

        if (CONFIG.SHOW_SUMMARY) {
            report.push(generateProjectSummary(allFiles));
            report.push('─'.repeat(80));
        }

        report.push('⚙️ НАСТРОЙКИ СКАНЕРА:');
        report.push(`• Исключенные папки: ${CONFIG.EXCLUDE_DIRS.slice(0, 5).join(', ')}...`);
        report.push(`• Свернутые папки: ${CONFIG.COLLAPSE_DIRS.join(', ')}`);
        report.push(`• Макс. глубина: ${CONFIG.MAX_DEPTH} уровней`);
        report.push(`• Макс. размер файла: ${formatBytes(CONFIG.MAX_FILE_SIZE)}`);
        report.push(`• Макс. строк: ${CONFIG.MAX_LINES}`);
        report.push('─'.repeat(80));

        projectStats.scanDuration = Date.now() - scanStartTime;

        report.push('✅ ИТОГИ СКАНИРОВАНИЯ:');
        report.push(`• Просканировано директорий: ${projectStats.dirs.total}`);
        report.push(`• Найдено файлов: ${projectStats.files.total}`);
        if (projectStats.scannedSymlinks > 0) {
            report.push(`• Симлинков: ${projectStats.scannedSymlinks}`);
        }
        report.push(`• Общий размер: ${formatBytes(projectStats.size)}`);
        report.push(`• Уникальных расширений: ${projectStats.fileTypes.size}`);
        report.push(`• Строк кода: ${projectStats.linesOfCode}`);
        report.push(`• Время сканирования: ${formatDuration(projectStats.scanDuration)}`);

        const contentFiles = content.filter(line => line.includes('СОДЕРЖИМОЕ:')).length;
        report.push(`• Файлов с содержимым: ${contentFiles}`);
        report.push('='.repeat(80));

        return { report: report.join('\n'), stats: projectStats };
    } catch (error) {
        return { report: `❌ ОШИБКА: ${error.message}`, stats: projectStats };
    }
}

function mainMenu() {
    console.clear();
    console.log(`
    ${B}╔════════════════════════════════════════════════════════╗
    ║          УМНЫЙ ГЕНЕРАТОР ОТЧЕТОВ О ПРОЕКТАХ          ║
    ╚════════════════════════════════════════════════════════╝${X}

    ${G}Возможности:${X}
    • Автоопределение типа проекта (20+ типов)
    • Группировка файлов по типам
    • Умная фильтрация служебных папок
    • Подсчет строк кода
    • Подсветка ключевых файлов
    • Детальная статистика
    • Пакетная обработка для скорости

    ${Y}Текущие настройки:${X}
    • Макс. размер файла: ${formatBytes(CONFIG.MAX_FILE_SIZE)}
    • Макс. строк в файле: ${CONFIG.MAX_LINES}
    • Макс. глубина: ${CONFIG.MAX_DEPTH} уровней
    • Размер пакета: ${CONFIG.BATCH_SIZE} файлов
    • Исключено папок: ${CONFIG.EXCLUDE_DIRS.length}
    `);

    rl.question(`${G}Введите путь к проекту (или "exit" для выхода):\n>${X} `, async (input) => {
        if (input.toLowerCase().trim() === 'exit') {
            console.log('👋 До свидания!');
            rl.close();
            return;
        }

        const dirPath = input.trim() || '.';
        console.log(`\n${Y}⏳ Анализирую проект...${X}`);

        const { report, stats } = await generateReport(dirPath);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const dirName = path.basename(dirPath) || 'project';
        const reportFileName = `project_report_${dirName}_${timestamp}.txt`;

        try {
            await fs.writeFile(reportFileName, report, 'utf8');
            const fileSize = formatBytes(Buffer.byteLength(report, 'utf8'));

            console.log(`\n${G}✅ Отчет сохранен: ${reportFileName}${X}`);
            console.log(`${G}📊 Размер отчета: ${fileSize}${X}`);

            console.log(`\n${C}📋 КРАТКАЯ СТАТИСТИКА:${X}`);
            console.log(`• Тип проекта: ${stats.projectType}`);
            console.log(`• Всего файлов: ${stats.files.total}`);
            console.log(`• Директорий: ${stats.dirs.total}`);
            console.log(`• Файлов кода: ${stats.codeFiles}`);
            console.log(`• Строк кода: ${stats.linesOfCode}`);
            console.log(`• Размер проекта: ${formatBytes(stats.size)}`);
            console.log(`• Время сканирования: ${formatDuration(stats.scanDuration)}`);

            if (stats.engineInfo.engine) {
                console.log(`• Движок: ${stats.engineInfo.engine}`);
            }
        } catch (error) {
            console.log(`${R}❌ Ошибка сохранения: ${error.message}${X}`);
        }

        console.log('\n' + '─'.repeat(80));
        rl.question(`${G}Нажмите Enter для нового сканирования или введите "exit":${X} `, (answer) => {
            if (answer.toLowerCase().trim() === 'exit') {
                console.log('👋 До свидания!');
                rl.close();
            } else {
                mainMenu();
            }
        });
    });
}

rl.on('close', () => {
    console.log('\n✨ Работа завершена.');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('\n\n👋 Завершение работы...');
    rl.close();
});

console.log(`${C}🚀 Загрузка умного генератора отчетов...${X}`);
setTimeout(mainMenu, 1000);
