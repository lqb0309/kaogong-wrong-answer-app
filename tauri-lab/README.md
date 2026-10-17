# Tauri 独立验证版

验证目的：在 macOS 系统 WebView 上检查粉笔登录与已完成报告读取、公共资料/子题/原始解析、独立 SQLite 保存、连续长页 PDF。它不是正式题库的替代品，不导入正式数据，不调用 AI，也不读写 Obsidian。

## 构建与运行

需要 Node.js、Rust 稳定版和 macOS 原生开发工具。

```bash
cd tauri-lab
npm ci
npm run dev
npm run test:rust
npm run build
```

构建前自动从主项目的 `fenbi-page.ts` 生成共享报告读取器，避免两份解析逻辑分叉。应用包位于 `src-tauri/target/release/bundle/macos/小乖错题屋-Tauri验证版.app`。生成读取器和编译目录不提交。

## 使用

1. 点击“打开粉笔登录”，在独立窗口登录并打开一份已完成练习报告。
2. 点击“读取当前完成报告”。题量、答案与报告汇总不一致时拒绝保存。
3. 左侧阅读公共资料、题目和选项，右侧阅读原始解析；公式图片保留在文字对应位置，可点击放大。
4. “连续长页PDF”直接生成可滚动的长页；“打印存PDF”使用系统打印窗口处理 A4。两种方式均检查图表、公式是否加载成功。

应用标识 `com.deca.wrong-answer.tauri-lab`，数据库在 `~/Library/Application Support/com.deca.wrong-answer.tauri-lab/lab-only.sqlite`；与正式 Electron 应用隔离。PDF 写入此目录下的 `exports`。正常启动恢复最近保存的报告，无需重新抓取。

## 已验证与限制

- 本机真实登录后读取一份 15 题资料分析报告，取得公共资料、题目与原始解析。对验证库副本进行集成测试：73 张图片（含 71 张解析公式）全部加载，原生连续 PDF 成功生成。
- 公式不会当作普通 Markdown 文本，也不执行外来 HTML；不可信公式地址显示明确提示，未加载图片阻止导出。
- Rust 4 项报告校验测试，以及主项目内 3 项公式显示/来源安全/缺图导出测试。
- 系统 A4 打印窗口尚需手动验收分页，不能用连续长页 PDF 测试替代。
- 尚未做离线图片缓存、批量日期同步、后台 AI、完整题库/知识卡片/组卷迁移、Windows/Linux 验证或签名公证。
- 系统 WebView 与 Electron 使用独立登录会话。粉笔再次修改页面仍可能需要适配。一次报告成功不代表所有题型和页面永远兼容。
- 约 10 MB 的验证包只包含最小功能，不能与完整 Electron 包的体积直接比较，也未做正式性能/内存基准。

测试专用 `WRONG_ANSWER_TAURI_SMOKE_DIR` 仅在 debug 构建生效且必须指向 `/private/tmp`，release 构建不启用自动测试入口。不要将真实报告、账号会话或生成的数据库提交到仓库。
