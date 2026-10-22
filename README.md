# QuizForge Android

面向 Android 平板的独立离线刷题应用。主要适配目标为 **Android 15 平板**，安装下限为 Android 10 / API 29；题型执行还需要支持 JavaScriptSandbox 的系统 WebView。应用启动时检测环境，缺少能力会明确提示更新 WebView，不改用无隔离的执行方式。

此工程独立于 `quizforge_web` 和 `quizforge_hub`。题库、作答、笔迹与历史保存在 Android 应用私有目录；本地练习、编辑和考试可以离线使用。可选联网用于 Hub 下载与自选模型 AI 评分，不连接电脑，不做云端答题同步。Hub 账号暂由系统浏览器管理，应用内原生登录仍需 Hub 的移动授权接口。

开发顺序为：先更新 Web，再同步 Hub 和 Android。Android 复用已确认的 Web 功能和界面，只做必要的平台适配；不自行新增菜单、功能或数据交换格式。

## 已实现范围

- 通过 Android 文件选择器导入格式 3 的 `.qbank`，单题库、整组和混合题型使用原 Web 拓展；重复导入生成独立副本。
- 本地 WebView 直接运行 Web 版完整界面：原页面、样式、图标、题库目录、标签页、答题区、悬浮翻题、外观设置和白板。离线接口适配层连接安卓存储，不重新设计一套界面。
- 保留 QF API 1.0–1.5、富文本、公式、图片和人工评分的契约；显式声明 `answer-areas` 的题型复用 Web 1.4.1 答题区，文字、图片与宿主笔迹位于同一逻辑平面。
- 通过 AndroidX JavaScriptEngine 在单独进程中的新 isolate 运行原始 `rules.js`；采用 AJV 校验、执行超时、内存与结果大小限制。
- 作答和草稿自动保存；写入成功后才显示已保存，失败保留当前输入并阻止切题。
- 提交判分、待人工评分、完成一轮、冻结历史和开始新一轮。
- 沿用 Web 的响应式侧栏、目录和窄屏抽屉；安卓原生窗口适配横竖屏、分屏和软键盘。
- 直接使用 Web 的一体式白板及其纸张、笔迹与视图格式；真实手写笔效果需要对应设备验收。
- 草稿工具栏保留原全屏按钮；安卓原生承载标准 HTML 全屏，退出恢复原页面，系统返回键先退出全屏。
- 沿用原 Web 题库分组、改名、移动、删除与导出界面；回收站恢复保持本地标识、作答和历史。系统文件选择器保存单库或整组格式 3 `.qbank`。
- 沿用题型原始编辑器纠正题干、选项、答案、解析和分值；按 Web 最新规则一次只编辑当前题，必须显式保存或取消，有修改时阻止切题／切库，刷新和关闭丢弃未保存作者编辑。普通作答与笔迹自动保存不变。源题与状态一起提交；内容更改只重置该题当前答案和笔迹，已完成历史保留。仍尊重题库作者的 `editing` 开关。
- 本地考试冻结题目、拓展和富文本组件，保存答卷和截止时间；重开时检查超时，手动或到时交卷后锁定，人工评分完成后进入历史。`history=false` 的考试仅在当前页面保留。
- Hub `quizforge://hub/import` 在安卓上接收官方固定版本下载，校验长度和 SHA-256 后调用同一导入器；“获取题库”在系统浏览器打开官方广场，远程页面不接触原生桥。
- 原 Web AI 设置与题卡接口，使用用户自己的 HTTPS OpenAI 兼容模型；凭据由 Android Keystore 加密保存，失败或中断任务需显式重试。当前考试仍使用客观判分和人工评分，AI 评分用于普通练习。
- 侧栏沿用 Web 的“设置＋获取题库”，不增加“更多”“本机数据”或独立账户菜单。之前预览版独有的 `.qfbackup` 功能已撤回；跨端备份等待 Web 定义统一方案。
- 随包提供四种公开基础题型的体验题库。个人题库和现有电脑练习记录不打包、不迁移。

新答题区提交使用独立可信离屏 WebView 完整合成，复用 Web 模型与笔刷，覆盖视口外答案；不接受题型提供的截图。纯文字交给 AI 文本评分，含图片或笔迹时使用完整区域 PNG。草稿不生成评分图，冻结历史保留当时组件与提交图。手动草稿截图按 Web 移除。Android 独有备份保持撤回，登录和额度等待 Web 后续统一更新，云同步不做。V2 包格式不在本版兼容范围内。Hub 配合事项见 [交接指令](docs/HUB_HANDOFF.md)，AI 网络与任务边界见 [AI 文档](docs/AI_ANDROID.md)。

## 构建

需要 Node.js 24、JDK 17 或更高（推荐 Android Studio 自带 JBR 21）和 Android SDK Platform 36。AGP 9.0.1、Gradle 9.1.0、WebKit 1.14.0、JavaScriptEngine 1.1.1 已固定版本。

```powershell
.\Build-Android.cmd
```

入口安装锁定的 npm 依赖，运行自动化测试，打包离线资源，再执行 `assembleDebug` 和 `lintDebug`。首次下载构建依赖需要联网；安装后的核心使用不需要联网。输出为 `output/QuizForge-Android-0.1.0-preview.apk` 和 SHA-256 文件。

自定义环境：

```powershell
.\Build-Android.ps1 -JavaHome 'C:\Program Files\Android\Android Studio\jbr' -SdkRoot 'C:\Users\你的用户名\AppData\Local\Android\Sdk'
```

同一签名、同一应用 ID 的覆盖安装保留应用数据。此版本是开发签名的预览 APK，应用 ID 为 `cloud.treenewbee.quizforge.android.debug`；卸载会由 Android 删除私有数据。`.qbank` 只交换题库内容，当前尚不提供跨端个人作答、笔迹和历史迁移。既有 `.qfbackup` 文件和旧恢复事务兼容处理保留，但不再提供新的备份导出或恢复入口。旧版已安装体验题库的作者开关保持原样，更新不会擅自重写旧题库。

## 源码与资源

```text
app/src/main/java/.../   Android 外壳、安全桥、题库导入、原子存储、规则运行器
web/                    原 Web 页面入口、离线 REST 适配、业务和原生请求客户端
rules/runtime.js        与 Web 行为对照的纯 JavaScript 规则执行适配器
vendor/quizforge-web/    完整 Web 前端、SDK、公共富文本组件和公开基础示例的固定快照
vendor/snapshot.json    每份复用文件的 SHA-256 与捕获时间
tests/                  规则、业务、输入与界面测试
app/src/androidTest/    Android 真实存储与隔离执行测试
docs/                   架构和验收范围
```

`vendor/` 是构建输入；之后独立构建不要求存在电脑端工程。只有明确要更新复用组件时才运行 `npm run snapshot:web`，该命令读取相邻 `quizforge_web` 的当前工作区并重建校验清单，不修改来源工程。

原 Web 入口只增加 Android 预加载脚本和窗口适配样式。构建生成的 `android-app.js` 保留原 `app.js` 的完整字节，仅追加原生生命周期保存钩子。原型 `tablet-app.js`、`tablet.css`、`ink-board.js` 不进入 APK；相关旧原型测试不作为当前产品界面验收。

## 验证

```powershell
npm test
.\gradlew.bat connectedDebugAndroidTest
```

规则测试会在存在相邻 Web 工程时，用发现的本地拓展和原始执行器做输出对照；缺少来源时会明确跳过该对照，其他独立测试仍运行。规则对照不代表超出当前宿主 API 的页面能力已经兼容，导入仍检查拓展声明。构建通过、规则对照、模拟器界面、真实平板和手写笔是不同的证据层级。实际结果见 [验收记录](docs/VALIDATION.md)。

真机首轮步骤：安装 APK → 导入实际 `.qbank` → 开飞行模式 → 作答和书写 → 切后台/锁屏 → 重新打开确认恢复 → 提交和人工评分 → 完成一轮 → 查看历史 → 横竖屏与分屏操作。Android 15 本身不能代替具体设备、WebView 版本与手写笔验证。
