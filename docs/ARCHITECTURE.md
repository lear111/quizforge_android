# 安卓离线宿主

## 运行边界

应用仅访问 `https://appassets.androidplatform.net` 下随包资源，不运行 HTTP 服务，也不连接电脑。AndroidX WebViewAssetLoader 将原 Web 的绝对静态路径映射到 APK。题型 iframe 继续使用原 SDK、`sandbox=allow-scripts` 和禁止联网的 CSP。

完整 Web 前端保存在固定快照中。入口保留原 DOM、全部样式顺序、图标与 `/app.js`，同步预加载脚本先拦截 `/api/` 请求，以直接 JSON、HTTP 错误和二进制图片响应连接原生存储。原 `app.js` 只在生成副本末尾追加 Android 生命周期、当前资源所有者和系统文件导出钩子，原文件和其他模块保持原始字节；界面、标签页、编辑器、考试控件、保存队列、历史视图和白板仍由原 Web 代码管理。题型开发和电脑网络主机设置继续隐藏。

原生桥只注入固定应用来源，且只接受主 frame 的消息。题型 iframe 通过已有 QF 消息协议请求受控操作，不直接得到 Android Java 对象、私有路径或存储权限。主页面不将原始答案投射给题型，只传规则 `project` 的公开输出。

评分使用 AndroidX JavaScriptSandbox 的独立进程。每次请求创建新 isolate，提供题型源码、Schema 和有界 JSON，请求结束后关闭。超时关闭执行 isolate；不支持终止或内存限制的 WebView 被明确拒绝。规则运行器不绑定原生文件、网络或 DOM API。

## 保存与历史

题库包先在私有 staging 目录完整解压校验，验证清单、路径、资源、Schema 和规则后才发布新的导入根与目录项。包不能覆盖已有题库，也不能指定本地保存身份。

练习写入以题库为单位串行，带期望 revision，并由 Android AtomicFile 提交；失败时旧状态继续有效。界面只有收到成功回执后才显示已保存，切题前等待 iframe flush 和画布落盘。系统强制结束前尚未发送的输入仍属于未确认内容，不能宣称无条件零丢失。

完成一轮前提交已保存的作答；主观题 pending 状态保持空分数，人工评分完成后才冻结历史。历史冻结公开题目、成绩、页面/SDK 字节和笔迹，不根据后来拓展重新计算。图片以 SHA-256 标识，存储后不原位覆盖。

历史响应在原题型脚本之前执行归档的富文本组件，避免原 Web 的共享 SDK 缓存替换历史字节。早期安卓原型只归档了静态组件，没有归档重型编辑器；这类旧记录仍使用同版本内置编辑器。新记录同时归档静态组件与编辑器。API 1.5 页面与考试另外冻结完整答题区提供器脚本／样式和已提交图片，不按新组件重新合成旧历史。

答题区规范化复用固定 Web 模型。草稿保存只校验文档与资源；提交通过原生 `AnswerAreaRenderer` 的短时内存任务逐张校验图片并合成。渲染器使用独立 WebView，仅加载固定 HTML／脚本、模型与笔刷，不加载题型页面、不接收任意 URL、不访问账号或通用原生桥。完整逻辑平面按 Web 规则绘制，统一笔迹／混合答案为 2 倍分辨率，旧纯笔迹保留原 1 倍软件栅格；结果经摘要、格式、尺寸与限额复验后写入原资源作用域。临时练习与临时考试不落盘；AI 只在本次请求中接收确切引用的临时图片并复验摘要，总图片限制沿用 8 张／8 MiB。

题目作者编辑沿用新 Web 的单题显式保存／取消，关闭时不另存作者草稿。旧作者草稿文件和兼容存储接口保留，新页面不会恢复未保存编辑。生命周期钩子仍排空普通作答与白板保存；应用内导航调用 Web 的 dirty 编辑检查。

统计与投影的只读规则响应按完整输入复用，缓存至多 512 项、8 MiB，包含题库、题目、准确拓展路径、操作和完整数据/版本。提交、人工评分与校验不缓存；状态变化重新计算对应题目。此缓存减少冻结历史和统计汇总中的重复计算，不改变规则隔离方式。

`features.history=false` 的题库不持久化作答、草稿、成绩或上传图片；状态只存在当前应用页面内存。该功能含义与 Web 保持一致。

## 平板输入

题库、题目与白板直接沿用 Web 的布局和交互。白板使用原 `schemaVersion:1` 文档格式，保留纸张、笔迹与布局；镜头位置按原 Web 行为在当前设备会话记住。早期安卓原型的笔迹格式保留兼容读取。原生窗口根据系统栏和 IME 调整 WebView 可用区域，Android 专用样式只解除原 `.app-shell` 的最小高度限制。针对真实手写笔、防误触和延迟保留设备验收。

草稿全屏仍由原 Web `createDraftFullscreen` 与工具栏控制。Android `WebChromeClient` 实现 `onShowCustomView/onHideCustomView`，让 WebView 正确报告全屏能力；全屏视图承载于窗口 overlay，原 WebView 保留并继续提供桥接和保存。全屏隐藏系统栏，单独处理键盘、刘海与窗口标题栏边距；退出时恢复此前窗口状态。系统返回先退出全屏，再次返回才进入原保存退出流程。显示进程异常或页面销毁时清理 overlay，避免残留空白层。

## 账户和云端

可选联网只有原生 Hub 下载器和用户明确配置的 AI 模型；WebView/题型的网络与桥接边界保持不变。Hub 浏览器账号入口不读取 Cookie、不声称 App 已登录；原生移动登录需要服务端新增授权流程，见 `HUB_HANDOFF.md`。本机练习免登录，不进行云端答题同步。

编辑使用持久 HMAC 内容/源版本、请求回执和可恢复多文件提交，保护题库 ID 和冻结历史。改名和移动刷新元数据而保留临时会话答案；内容编辑仅清理目标题当前状态。

考试使用独立持久文档和原始题目/拓展/富文本快照，在每次访问、提交和重开时检查截止时间，过时写入被拒绝。Android 可能暂停后台 JavaScript，所以不宣称应用被关闭时仍执行评分；重新打开后按保存的截止时间锁定并完成交卷。普通练习 AI 和考试的自动评分暂未合并，考试主观题可人工评分。

Android 独有完整备份因未经过 Web 统一定义而撤回；不再加载数据菜单或提供备份桥和文件选择器。仅保留旧恢复日志在打开仓库前的兼容处理，保护旧预览版可能留下的事务与数据；不会自动导出新备份。已有 `.qfbackup` 文件保留，当前不宣称跨端可恢复。功能同步边界见根目录 `AGENTS.md`。

## 官方依据

- [应用内离线 Web 内容](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)
- [JavaScriptEngine 与隔离执行](https://developer.android.com/develop/ui/views/layout/webapps/jsengine)
- [原生桥接的来源与 frame 限制](https://developer.android.com/develop/ui/views/layout/webapps/native-api-access-jsbridge)
- [WebView 原生全屏回调](https://developer.android.com/reference/android/webkit/WebChromeClient)
- [沉浸模式与系统栏](https://developer.android.com/develop/ui/views/layout/immersive)
