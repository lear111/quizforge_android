# 验收记录

实现目标：Android 15 平板，离线使用，兼容当前 Web 题型拓展。具体设备型号与手写笔型号尚未提供。

## 2026-10-21 Web 最新同步（当前构建）

最新候选已完成全量 167 项检查与打包。`2c0e…` 的实际冷切换 trace 确认，新题库 iframe 请求图片时上下文仍是旧 active，导致两张图片 **102 次读取／100 次 miss／2 次 hit**，约 10,292 ms；证据独立保留 `prior-2c0e/`。已补 Android 候选只读上下文与 preload／GET 转发，POST、旧页 flush、无候选和失败移除保持 active，非法 pending key 不采信。新增五项回归，四个相关文件 **63/63** 通过，未放宽 Web 超时或修改 pinned Web 源码；当前包的模拟器设备结果见下文；真机仍待验收。

上一 `7dd7…` 候选原生 68 项、界面 12 项与原 50 库哈希保全通过，但飞行模式强停冷启动卡在初始基础库题目 GET 超时，未进入验收样例，冷启动记失败；独立证据归 `prior-7dd7/`。审查后只移除目录 overview 中未被界面使用的评分调用：未提交且声明 `answer-state` 的进度及无子题条目不再评分，已提交／未声明能力的子题进度、汇总和判分保持。新增三项回归，相关两个文件 **42/42** 通过。没有延长 Web 超时或认定硬件／OOM 为根因，旧候选结果不能作为最新包通过。

已补完成回合后的白板保存对齐：仅题目标题改动不会重开回合；切草稿初始化布局时允许保存当前白板，并禁止更新已完成冻结历史，其他作答操作仍受完成状态限制。相关两个测试文件 **39/39** 通过，已纳入当前候选全量自动化与打包。

用户已授权同步全部 Web 已完成功能，API 1.5 答题区纳入本轮。当前 APK 为 `0.2.0-web-sync-preview`（versionCode 5），9,535,093 字节，SHA-256 `7fa8cf711d4fbfd1ec3662bda3d82cf7c055c7aede7a5a9ba50f9bfac9509835`。JavaScript **167/167** 通过，无跳过；其中打包 renderer 的 Node Canvas 像素适配器检查 5/5 通过，不等同于浏览器或 Android WebView。构建、lint（0 errors、5 warnings）、136 份打包资源及签名检查通过，签名与既有预览包一致。

当前 `7fa8…` APK 冷切换直接查图已通过：`normalStartupReady:true`，两张旧验收题库图片只发生 **2 次原生读取，2 次命中、0 次未命中**，全部直达目标，`cold-switch-timing.json` 为当前摘要且 `passed:true`；旧 `2c0e…` 的 102 次读取／100 次 miss 独立保留。

当前 APK 已通过真实 SAF 新导入与 WebView **12 项界面检查**，`app-acceptance.json` 绑定当前摘要且 `passed:true`：纯文字草稿／提交无 snapshot，PNG 粘贴和合成笔迹保存、原生混合出图提交、人工评分 5/5、完成后冻结提供器 1.4.1、历史只读快照解码、单题取消／导航阻止／显式保存、完成回合白板历史保全及实际全屏进出。合成输入不能代替实体手写笔。

本包飞行模式强停冷启动通过（飞行模式 1／Wi-Fi 0），初始题库页面就绪，打开本轮样例实际解码 **1520×960** 已保存 PNG，完成状态、5 分、历史 ID 与 51 本总量保持。`offline-restart.json` 当前摘要且 `passed:true`，截图 `offline-restored.png`；24,584 ms 是整个脚本流程耗时，不作为首屏速度。`post-fixture-preservation.json` 进一步确认原 **50 本**元数据、源内容、完整作答与冻结历史哈希逐项一致，只新增一份双题验收样例。当前 APK 完整原生测试 **68/68** 通过，耗时 **28.077 秒**，`native-run.json` 绑定本包摘要、专用设备与原始日志 SHA-256，68 个成功测试块含 renderer 5 项／AI 13 项；先做界面／冷启动再跑 instrumentation 的顺序调整不是故障归因。

本轮准备正常恢复 1520×960 旧快照及 5 分，仅归档旧合成题库；之后 System UI ANR 弹窗覆盖已加载基础题卡，实际选择 Wait 恢复。目前本轮未出现图片超时，系统提示根因未定；当前 `initial-ui-retry.json`／`system-ui-wait.png` 保留，不能描述为全程无异常。

旧 `7dd7…` 候选完整原生 **68/68** 通过（148.508 秒，renderer 5 项／AI 13 项），应用 WebView **12 项界面检查通过**，原 50 库保全通过，证据见 `prior-7dd7/`：真实 SAF 导入，纯文字无 snapshot，PNG 粘贴与合成 pen，原生混合出图、人工 5/5、冻结提供器 1.4.1、历史只读快照解码、单题编辑与导航、已完成白板历史保全、实际全屏。其离线冷启动失败，不能列为全部设备验收通过。合成输入不能代替实体手写笔。

该旧候选界面准备阶段出现 System UI ANR 并选择 Wait，随后首次准备 `Runtime.evaluate` 超过 60 秒并显示图片后备；App 强停重开后一次题卡 GET 超过 12 秒，实际“重新加载题卡”恢复。原生 PNG 44,867 字节完好，资源 GET 曾返回 200、约 254 ms；准备流程随后恢复 1520×960 快照及 5 分，仅回收旧合成验收题库以重走 SAF。证据 `prior-7dd7/initial-ui-retry.json` 保留；根因未确立，不推断为 OOM，不将后续通过描述成全程无异常。

启动中发现并修复普通 `core/web/shared/*.js` 与版本化 `core/shared/answer-area/`、`ink/`、`richtext/` 的静态路由混淆，并增加两项实际映射及完整相对导入图回归检查。混合答案重载图片时，又定位并修复资源 GET 为查图加载无关完整题库、作答和历史导致的超时：当前库优先，已加载内存 snapshot 保持可读，其他库只查原生资源；增加两项作用域回归，临时会话图片与 AI 附件测试继续通过。

资源读取修复前的旧候选（SHA-256 `e06ab06ce66292a2588e316efeaf78f189bded0c4d44263ddaeecb99304a8981`，`build-info-e06.json`）已完成同签名覆盖升级，`upgrade-before.json`／`upgrade-after.json` 确认原 **50 本题库**的身份、源内容、作答与冻结历史哈希一致。其 instrumentation 首轮 **68 项中 67 项通过、1 项失败**，失败为 `packagedDemoImportsThroughRealSchemaAndRulesValidation` 的 `SandboxDeadException`，日志为 `native-instrumentation.txt`；整个 `RuleRuntimeTest` 单独重跑 **6/6** 通过，见 `native-rules-retry.txt`。原生 renderer 5/5、AI 13 项通过亦属该旧候选。

`8e035…` 候选在专用 Android 15 模拟器完整 instrumentation **68/68** 通过，耗时 **74.498 秒**，原 50 本题库数据保全通过，证据另存 `prior-8e035/`。其界面验收随后发现完成回合切草稿的保存冲突，不能列为全部界面通过。更早旧候选的真实 SAF 样例导入及文字／混合答案保存提交已执行，曾出现图片／保存超时后重试通过，重载又复现查图超时，未把宿主内存紧张推断为 OOM。`7dd7…` 的原 50 本数据保全通过、离线冷启动失败，均作为旧候选证据保留。实体平板、手写笔和相机未验收。旧候选或旧版设备结果不列为新 APK 通过。

最终汇总 `output/acceptance/web-sync-20261021/acceptance.json` 绑定当前 APK 与 **44 份证据**，专用 AVD 已正常关闭并保留数据。真机手机／平板、手写笔、相机、软键盘、横竖屏和双触选图仍需验收。

详细同步来源、功能范围和待验收清单见 [Web 同步记录](WEB_SYNC_2026-10-21.md)。登录、AI 额度仍暂缓，云同步不做，独立备份保持撤回。以下为历史记录。

## 2026-10-21 撤回 Android 独有备份（历史构建）

遵循用户确定的顺序：先在 Web 定义、实现和验证，再同步 Hub 与 Android。Android 独有 `.qfbackup`、侧栏“更多”和设置“本机数据”均不属于已确认 Web 功能，已撤回。新 APK 不打包 `android-library-extras.js`；原生备份桥、文件选择器及恢复确认链已移除。仅保留仓库启动时的旧恢复事务兼容处理；没有运行恢复、清理数据或删除已有备份。题库交换继续使用既有 `.qbank`。

当前版本 `0.1.0-web-aligned-preview`（versionCode 4），APK SHA-256：`d70be736ca567bc3b6d5a6157a3e13aca30a0e9c366e75886aaf8dc85c2b1e9a`。JavaScript 129/129 通过，无跳过；旧独立菜单测试已归档，当前增加了打包产物不含该功能的边界检查。`assembleDebug`、`lintDebug` 通过，lint 0 errors、3 warnings；116 份 APK 资源匹配，签名与包名延续旧预览版，versionCode 递增。

1280×720 浏览器替身预览确认侧栏只有原“设置＋获取题库”，设置仅显示当前可用的原 AI/外观分类，不含备份或独立账户页签。原生和网页获取题库均保留 `/manage/#library` 修正。没有安装本轮 APK、运行设备测试或访问个人数据；旧 54 项 instrumentation 与真实 SAF 记录仍只属于旧版。

证据：`output/acceptance/backup-withdrawal-20261021/`。被撤回的 versionCode 3 APK 与证据保留在 `output/archive/pre-backup-withdrawal-20261021/`。开发边界写入根 `AGENTS.md`。下方为历史记录，不代表当前交付功能。

## 2026-10-21 界面入口调整尝试（已撤回）

当时 APK 为 `0.1.0-ui-preview`（versionCode 3），SHA-256 `aaf7074e0bd21f1eaa4a4a7417f855626b301aa8553fff43dda9cc59e4489bb8`。曾将回收站、完整备份移至设置的“本机数据”，随后按用户要求整体撤回。仅保留“获取题库”的原生固定跳转和网页 href 直达 `https://quizforge.treenewbee.cloud/manage/#library` 的修正。

JavaScript 135/135 通过，无跳过；其中用原 Web 的外观、AI 设置绑定验证本机数据页签互斥、备份和恢复失败保护。`assembleDebug`、`lintDebug` 通过，lint 0 errors、3 warnings，117 份 APK 资源与 staging 一致。包名和开发签名证书与上一版一致，versionCode 递增。此前 54 项 Android instrumentation、实际 SAF 和 Hub 模拟器记录属于上一版，本次没有重跑，不能列为新 APK 的设备验收。

1280×720 浏览器预览使用空题库和内存中的原生桥替身，核对真实打包页面的侧栏、设置、本机数据及备份取消反馈；没有读取 App 私有数据、运行 SAF、安装或操作设备。截图与本轮证据见 `output/acceptance/ui-alignment-20261021/`。未改 Web/Hub 产品源码；固定快照只同步了 index.html 的广场 href，未接入新答题区、原生登录或额度。旧 APK、构建信息及上一版索引引用的证据保留于 `output/archive/pre-web-layout-fix-20261021/`；下方内容为历史记录。

## 2026-10-21 Hub 浏览器联合验收

已用更新后的完整 Hub 前端、独立临时数据和 Android 15 模拟器内的真实 Chrome 完成网页点击。未运行客户端被唤起并打开目标题库；再次点击保持同一进程；强停并关闭网络后点击，以新进程打开已下载题库。三次均保持原 50 本题库的目录、源内容、作答及历史摘要。Hub 指定 16 项测试通过；桌面和手机窄屏入口、实际匿名文件下载也已核对。

此次命中已有回执，未重复原生网络下载；浏览器首次下载的进度/取消/错误、未安装 App、其他浏览器、实体设备与正式发布包仍需验收。APK 和产品源码均未改动，也未部署 Hub。详情与证据见 [联合验收记录](HUB_JOINT_VALIDATION.md)。下方历史记录中“未做浏览器点击”描述对应当时的验收范围，已由本节补充。

## 功能预览版（本轮）

当前版本 `0.1.0-feature-preview`（versionCode 2），开发签名、同包名可覆盖旧预览版。APK SHA-256：`2d3fdf4d79406b2c20bc230699e8674c960008eacd3585648d7f33109ed4c4ae`。本轮不修改 Web/Hub 来源工程，不加入 API 1.5 `answer-areas`，不进行云端答题同步。

- 全部 JavaScript 检查 127/127 通过，无跳过；包含本地拓展规则对照、原 Web 字节与样式保留、管理/编辑/资源、考试、AI 及生命周期确认。
- Android 15 原生 instrumentation 54/54 通过：存储与管理编辑、完整备份、文档版本、Hub 下载器、Keystore/模型 mock 及隔离运行器。首次两项失败（系统提前拒绝 ZIP 路径时的错误映射、JSON 转义造成的图片诊断断言）均已修正，旧失败日志单独保留。
- `assembleDebug`、`assembleDebugAndroidTest`、`lintDebug` 成功；lint 0 errors、7 warnings。APK v2 签名有效；117 份打包资源与测试后的 staging 一致，仅新增 INTERNET 普通权限。
- 独立 Android 15 AVD 使用 1280×800 物理像素、density 160；横屏可用 Web 视口为 1280×744。为缓解宿主内存压力降低渲染分辨率，未使用个人设备或真实手写笔。
- 实际系统文件选择器导入独立 all-features 示例；原 Web 编辑器修改分值/正确项，等待原生编辑草稿回执，强停重开后恢复，保存后按新答案判为 3/3。保持题目 ID 与拓展绑定。
- 原 Web 分组新建/改名、题库改名/移动、删除与回收站恢复保持安装 ID 与答案；原有两份示例的作答投影保持一致。
- 考试独立作答、完成与冻结历史只读探针通过。首次 CDP 接管 JS 确认时残留 Android 对话框，旧截图保留且不作为原生确认按钮验收。补测实际点击 Android 的 OK 按钮，完成交卷后对话框消失，普通练习保持一致、冻结历史拒绝写入；`exam-confirm-flow.json` 为通过记录，`parity-landscape.png`、`parity-portrait.png` 已更新为干净横竖图，均无溢出或题型错误。
- 完整备份通过原“更多”入口，实际 SAF 导出 4,782,216 字节 `.qfbackup`，仅临时修改独立验收题库的标题，再从 SAF 选择该备份并实际点击原生“恢复备份”。恢复后的 50 本题库目录、源内容、完整作答与历史摘要逐项一致，AI 配置状态和脱敏摘要保持一致。初次脚本误把未刷新旧 DOM 当成恢复完成，原生存储门禁正确返回 `STORAGE_MAINTENANCE`；该失败保留在 `backup-flow.json`。随后只读检查等待已确认的恢复完成，未重复恢复或改动题库，`backup-restore-verification.json` 通过。已修正脚本等待原生门禁与新页面的条件。
- 现有官方 Hub v1 接口实际下载一份公开格式 3 包，长度和 SHA-256 一致，导入 47 本公开题库；暖启动重复链接、飞行模式下冷启动同一链接都保持 50 本总量，没有重复副本。深链使用 ADB `ACTION_VIEW` 经 Manifest 解析，未把它冒充浏览器首次唤起确认验收。报告 `hub-import-flow.json`。
- 一次 Hub 冷启动遭遇模拟器焦点 ANR，堆栈停在系统 `HardwareRenderer/RenderProxy.loadSystemProperties`，保留 `hub-startup-anr.txt`；恢复后真实下载和后续离线冷启动完成。此前还出现系统桌面/System UI 冷启动 ANR，均保留环境证据。不能把模拟器恢复结果作为真实平板稳定性结论。
- 编辑立即退出前最初遗漏编辑草稿落盘，已补 Android 生命周期钩子：等待 `persistEditorDraft` 及其写入队列后再确认退出。失败证据保留为 `parity-editor-before-lifecycle-fix.*`；修复后的重启恢复通过。

证据索引：`output/acceptance/feature-acceptance.json`，将当前 APK 摘要与 `javascript-tests.txt`、`feature-build.txt`、`feature-parity.json`、`android-instrumentation-feature.txt`、`hub-import-flow.json`、`exam-confirm-flow.json`、`backup-restore-verification.json`、`apk-verification.json`、`apk-signature.txt`、`apk-permissions.txt` 绑定。AI 使用虚构响应测试，未调用真实付费模型。当前账号入口由系统浏览器管理，App 原生登录等待 Hub 移动授权接口，未列为已完成能力。

完整 `.qfbackup` 包含个人作答与历史，不含 AI 凭据；恢复前自动副本及旧目录留在应用私有 `no_backup` 区，当前预览版尚无单独的旧副本管理界面。备份上限压缩 512 MiB、解压 1 GiB、单文件 128 MiB、50000 条目。真实平板、手写笔、相机和真实模型兼容性仍待真机验收。

## 草稿全屏修复（上一轮基线）

原 Web 工具栏依据标准 Fullscreen API 检测能力。修复前 APK 的 `document.fullscreenEnabled=false`，按钮因此自动隐藏；Android 外壳缺少 `WebChromeClient.onShowCustomView/onHideCustomView`。本次只补原生全屏承载、系统栏与返回键处理，原 Web 页面、脚本和样式保持不变。

- Android 15 模拟器实测：原草稿工具栏的四角图标可见，进入后真实 `document.fullscreenElement` 为页面根元素，横屏由 1280 × 744 扩展为 1280 × 800 CSS 像素，状态栏和导航栏隐藏。
- 同一工具栏按钮可退出并恢复系统栏；硬件返回键退出全屏后，原应用进程、前台 Activity 和题目页面继续保留。
- 离开草稿模式自动退出全屏，恢复正常布局；全屏中合成笔迹确认保存，转为竖屏仍保持全屏，无横向溢出或题型错误。
- 全屏中实际 Android 软键盘弹出时，页面仍保持全屏，可见高度为 432 CSS 像素，原简答题富文本编辑区位于 208.75–348.75，完全在键盘上方；文本确认保存，原生 revision 为 35。第一次返回只收起键盘，第二次返回退出全屏并恢复系统栏。
- 本次完整 JavaScript 检查 83/83 通过，包括当前本地目录中 23 份拓展的规则对照；新增接口示例的规则对照不代表 API 1.5 页面能力已经兼容，导入限制保持不变。`assembleDebug`、`lintDebug` 成功，0 errors、6 warnings，APK v2 签名有效，114 份 APK 资源与检查后的构建资源一致。

该轮 APK 已保留在 `output/archive/pre-feature-parity/`，SHA-256：`eacbd28e68b7b879c5eb96ddaf0cf9f9d0fadcd1a0cd2f8d9223f8d57a17a119`。前后对照和该轮证据保存在 `output/acceptance/fullscreen-before.json`、`fullscreen-flow.json`、`fullscreen-extra.json` 及 `fullscreen-*.png`。两个流程记录均为 `passed=true`；笔迹与文本使用合成输入，实体平板与手写笔仍待验收。本节为上一轮全屏能力证据，当前 APK 以上方功能预览版为准。

独立模拟器冷启动阶段出现过 SystemUI/Gboard 系统无响应对话框，影响了最初的返回键测试；相关日志和截图另存为 `fullscreen-coldboot-*`。系统恢复且首次沉浸提示被正常确认后重新执行了上述检查，未把受系统对话框拦截的输入计作应用通过或失败。

## 自动化

- 规则适配：当前 22 份拓展与原 Web 执行器对照，另有严格 Schema、投影隐藏答案、人工评分、pending、目录与异常输出测试。
- 离线业务：保存恢复、写入失败保留确认状态、状态反馈绑定、串行写入、人工评分完成历史、历史不可变、临时练习语义。
- 原生存储：导入独立副本、失败不发布、路径越界、ZIP 符号链接/加密、资源校验、原子状态与版本冲突、损坏数据保留。
- 平板界面：画布和界面输入的自动化使用合成事件，不能代替真机手写笔验收。

## Web 界面首次复用的执行结果（全屏修复前）

- JavaScript：完整 `npm test` 为 **82/82 通过**，没有跳过项目。其中包含 22 份现有拓展与原 Web 执行器对照；原版界面一致性、离线接口、冲突与重复请求、原白板、历史归档组件、图片和 Android 布局提示处理均有对应检查。旧原型的 12 项测试仅作保留回归，不作为当前产品界面验收。
- 原版前端：70 份 Web 前端文件与当前来源工程比较，无变化；入口仅增加预加载脚本与 Android 样式。所有原样式、图标与模块保持原始字节；生成的主模块只追加保存钩子，Android CSS 只有 `.app-shell{min-height:0}`。
- 构建与包：`assembleDebug`、`lintDebug` 成功，0 errors、6 warnings；开发签名 v2 验证通过。直接解开最终 APK 校验 114 份资源，全部与测试后的构建资源相同，旧自定义界面没有进入 APK。安装下限 API 29、目标 API 35，不请求任何 Android 权限，包括 Internet。
- 原生后端：此前在同一独立 Android 15 平板模拟器上完成 15 项存储/隔离执行测试，全部通过。原始 XML 保留；本次 Web 界面复用后的设备验证见下列记录。
- 离线实际界面：飞行模式下，通过原单选控件保存答案、强制停止后恢复选择、提交判分 2/2；原版富文本编辑器延迟加载并保存文档，人工评分 5/5；完成练习、只读历史拒绝写入、重新练习保留历史。`web-flow.json` 是分阶段执行记录，保留了早期测试脚本的选择器/等待条件修正说明，不宣称它是一次无中断执行。
- 原白板：合成笔事件产生的笔迹与网格纸张写入本地，切题后恢复。镜头移动遵循 Web 原行为，仅在当前设备会话记住。合成笔输入不等于真实手写笔验收。
- 最终 APK 复测：完成按钮到原界面显示“再练一次”为 **6,835 ms**，只使用界面轮询计时；冻结的简答题富文本正常显示，历史写入被拒绝且原生 revision 不变，新一轮保留已完成历史。此前诊断反复读取包含 SDK 的完整状态，不能用作有效性能对照；本次仅是四题体验题库的一次模拟器测量。
- 横竖屏：横屏 1280 × 744、竖屏 800 × 1224 CSS 像素，无横向溢出。实际 Android 软键盘弹出后，WebView 高度分别缩小至 408 和 888，原编辑区可见且文档确认保存。最终复测没有题型错误横幅；只过滤来自当前题型 iframe 的一条精确 Chromium ResizeObserver 布局通知，其他错误继续显示。
- 图片：实际主页面与不透明来源的原题型 iframe 均可加载 `data:image/png`，无需放宽原生来源限制。相机拍摄、系统文件选择器与具体设备图片处理仍应在真机验收。

最终 APK：`output/QuizForge-Android-0.1.0-preview.apk`，13,618,243 bytes；SHA-256：`5101b2581ee3dcb76b22da03c44f840cfac0d3daa25ad4f0a422aaacbad17c24`。

当前证据：`output/acceptance/javascript-tests.txt`、`apk-verification.json`、`apk-signature.txt`、`apk-permissions.txt`、`web-flow.json`、`web-final-smoke.json`、`web-keyboard-flow.json`、`web-data-image-probe.json` 及 `web-*` 截图。模拟器为独立 `QuizForge_Android15_Tablet` / Android 15 / WebView 124.0.6367.219，未使用个人题库或个人设备。

## 早期安卓原型记录（保留）

- JavaScript：规则对照 26 项通过（其中包含全部 22 份本地拓展副本），领域/界面/画布 22 项通过，合计 48 项。分组执行；领域层新增历史组件去重测试后重新执行了对应全部 22 项。
- Android：在独立 Pixel Tablet / Android 15 模拟器上执行 15 项原生测试，全部通过（10 项存储、5 项隔离规则）。没有跳过项目。
- 构建：Gradle `assembleDebug` 与 `lintDebug` 成功；lint 为 0 errors、6 warnings，剩余项目为固定依赖/工具版本更新和目标 API 提示。
- APK：开发签名验证成功，minSdk 29、targetSdk 35；最终 manifest 不请求任何 Android 权限，包括 Internet。
- 实际应用：在模拟器开启飞行模式后，通过原单选题页面选择答案并等待原生保存回执；强制停止应用、重新启动，页面恢复已选答案；提交后本地判分成功。
- 布局：实际 WebView 横屏 1280 × 744 CSS 像素、竖屏 800 × 1224，无横向溢出；已查看实际截图。

这些早期证据保存在 `output/acceptance/emulator-flow.json`、原横竖屏 PNG、复制的 Android 测试 XML 和 lint 文本报告；其中旧 `keyboard-flow.json` 的失败记录仍保留。它们不能代替上方原版 Web 界面的最终复测，也不能代替真实平板或真实手写笔。

## 真机待验收

1. Android 15 平板安装，记录设备型号、系统版本和 WebView 版本。
2. 在飞行模式下导入单题库与混合题型整组包，检查公式、图片与复杂阅读布局。
3. 单选、多选、判断、数学填空、英语阅读和作文分别完成作答、切题、恢复与判分。
4. 手写笔书写、压感、手掌接触、橡皮、撤销重做、手指平移与双指缩放。
5. 横屏、竖屏、分屏、软键盘、锁屏、切后台及应用进程重启。
6. 人工评分 pending 处理、完成一轮、历史只读与开始新一轮。
