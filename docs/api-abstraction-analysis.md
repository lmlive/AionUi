# AionUi dist-server/ API 抽象可行性分析报告

生成日期: 2026-05-22
分析范围: /home/liming/projects/AionUi/dist-server/

---

## 一、概述

dist-server/ 目录下包含两种主要部分：

1. **server.mjs** — 已打包的 Node.js/Express Web 服务（约 34MB，含完整路由体系）
2. **skills/** — AI skill 插件体系，内嵌多个 Python 脚本，覆盖 PDF 操作、PPT 处理、社交媒体发布、技能管理等功能

本次分析重点：**skills/ 下所有 Python 脚本**，评估其转为 FastAPI API 端点的可行性。

---

## 二、Python 脚本清单与功能分类

### 2.1 PDF 操作类（高可行性 ★★★★★）

路径: dist-server/skills/pdf/scripts/

| 脚本文件                          | 功能                             | 输入                 | 输出            | 核心依赖           |
| --------------------------------- | -------------------------------- | -------------------- | --------------- | ------------------ |
| merge_pdfs.py                     | 合并多个 PDF                     | 多个 PDF 文件路径    | 合并后 PDF      | pypdf              |
| split_pdf.py                      | 拆分 PDF 或提取页面范围          | PDF + 页面范围字符串 | 拆分后 PDF/目录 | pypdf              |
| convert_pdf_to_images.py          | PDF 页转 PNG 图                  | PDF + DPI            | PNG 图片集      | pdf2image, poppler |
| extract_form_field_info.py        | 提取 PDF 表单字段信息            | PDF                  | JSON 字段描述   | pypdf              |
| fill_fillable_fields.py           | 填写可填充表单字段               | PDF + JSON 字段值    | 填写后 PDF      | pypdf              |
| fill_pdf_form_with_annotations.py | 非可填表单覆盖文字注释           | PDF + JSON 坐标定义  | 注释后 PDF      | pypdf, reportlab   |
| check_bounding_boxes.py           | 校验 JSON 中 bounding box 合法性 | JSON                 | 验证结果文本    | 标准库             |
| check_bounding_boxes_test.py      | check_bounding_boxes 单测        | —                    | 测试报告        | 标准库             |
| check_fillable_fields.py          | 检测 PDF 是否含可填字段          | PDF                  | 布尔 + 字段列表 | pypdf              |
| create_validation_image.py        | 生成带 bbox 标注的验证图         | PNG + JSON           | 标注后 PNG      | Pillow             |

**转 API 适合度**: 极高。所有脚本为纯函数逻辑，以文件/JSON 为输入输出，无 UI、无浏览器依赖。
最适合 `multipart/form-data` 文件上传 + JSON 响应模式。

---

### 2.2 PPT/Morph 辅助类（中高可行性 ★★★★☆）

路径: dist-server/skills/morph-ppt/reference/

| 脚本文件         | 功能                                                      | 输入                   | 输出                  | 核心依赖                        |
| ---------------- | --------------------------------------------------------- | ---------------------- | --------------------- | ------------------------------- |
| morph-helpers.py | PPTX morph 动画辅助：克隆幻灯片、ghost 内容、验证过渡效果 | PPTX 路径 + 幻灯片参数 | 控制台输出 + 文件修改 | subprocess(officecli), colorama |

**转 API 适合度**: 中等。脚本依赖外部 CLI 工具 `officecli`，需确保服务器环境已安装。
可包装为异步任务 API（POST 触发，GET 查询状态），输出以 JSON 结构化。

---

### 2.3 Skill 管理工具类（中可行性 ★★★☆☆）

路径: dist-server/skills/\_builtin/skill-creator/scripts/

| 脚本文件          | 功能                                   | 输入              | 输出            | 核心依赖                        |
| ----------------- | -------------------------------------- | ----------------- | --------------- | ------------------------------- |
| init_skill.py     | 创建新 skill 目录结构及模板文件        | skill-name + 路径 | 文件系统目录    | pathlib(标准库)                 |
| package_skill.py  | 打包 skill 目录为 .skill 文件(ZIP)     | 目录路径          | .skill zip 文件 | zipfile(标准库), quick_validate |
| quick_validate.py | 校验 skill SKILL.md frontmatter 合法性 | 目录路径          | 布尔 + 错误信息 | pyyaml                          |

**转 API 适合度**: 中等。这些是文件系统操作工具，作为内部管理 API 合适，但需要权限控制（只允许在服务管理的目录下操作）。

---

### 2.4 社交媒体自动化类（低可行性 ★★☆☆☆）

路径:

- dist-server/skills/xiaohongshu-recruiter/scripts/publish_xiaohongshu.py
- dist-server/skills/x-recruiter/scripts/publish_x.py

| 脚本文件               | 功能                            | 输入                       | 输出             | 核心依赖                       |
| ---------------------- | ------------------------------- | -------------------------- | ---------------- | ------------------------------ |
| publish_xiaohongshu.py | 启动 Chrome 自动发布小红书图文  | 标题 + 内容文件 + 图片列表 | 浏览器自动化操作 | playwright, subprocess, socket |
| publish_x.py           | 启动 Chrome 自动发布 X(Twitter) | 内容文件 + 图片            | 浏览器自动化操作 | playwright                     |

**转 API 适合度**: 低。脚本依赖 headless Chrome + Playwright，需要完整 GUI 环境（或 Xvfb），
且执行过程包含长时间等待用户登录的交互逻辑。如需 API 化，需重构为：

- 异步任务队列（任务提交 + 状态轮询）
- 登录态持久化（cookie/session 管理独立化）
- 无头浏览器环境就绪检查

---

## 三、现有 server.mjs Express API 端点概览

server.mjs 已包含以下 Express 路由，供参考对比：

| 路径                          | 方法 | 功能            |
| ----------------------------- | ---- | --------------- |
| /api/auth/status              | GET  | 认证状态        |
| /api/auth/user                | —    | 用户信息        |
| /api/auth/change-password     | —    | 修改密码        |
| /api/auth/refresh             | POST | 刷新 token      |
| /api/ws-token                 | GET  | WebSocket token |
| /api/auth/qr-login            | POST | 二维码登录      |
| /api/channel/weixin/login     | GET  | 微信登录        |
| /api/directory/browse         | GET  | 目录浏览        |
| /api/directory/validate       | POST | 路径校验        |
| /api/directory/shortcuts      | GET  | 快捷目录        |
| /api/upload                   | POST | 文件上传        |
| /api/stt                      | —    | 语音转文字      |
| /api/ext-asset                | GET  | 外部资源        |
| /api/ppt-proxy/:port          | —    | PPT 预览代理    |
| /api/office-watch-proxy/:port | —    | Office 预览代理 |

---

## 四、FastAPI 重构建议

### 4.1 优先重构：PDF 操作 API（低风险，高价值）

推荐端点设计：

```
POST /api/pdf/merge          — Body: multipart (files[])       -> 返回合并 PDF
POST /api/pdf/split          — Body: multipart (file, range)   -> 返回 ZIP 或单 PDF
POST /api/pdf/to-images      — Body: multipart (file, dpi)     -> 返回 ZIP(PNG)
POST /api/pdf/extract-fields — Body: multipart (file)          -> 返回 JSON
POST /api/pdf/fill-fields    — Body: multipart (file, values)  -> 返回填充后 PDF
POST /api/pdf/fill-annotate  — Body: multipart (file, schema)  -> 返回注释后 PDF
POST /api/pdf/check-fillable — Body: multipart (file)          -> 返回 JSON
POST /api/pdf/validate-boxes — Body: JSON (fields schema)      -> 返回验证结果
POST /api/pdf/validation-img — Body: multipart (image, schema) -> 返回标注 PNG
```

#### 缺失依赖（需安装）

```bash
pip install pypdf pdf2image Pillow
# 系统依赖：
apt-get install poppler-utils   # 供 pdf2image 使用
```

环境现状：

- fastapi 0.136.1 ✅ 已安装
- pydantic 2.12.5 ✅ 已安装
- reportlab 3.6.8 ✅ 已安装
- colorama 0.4.4 ✅ 已安装
- pypdf ❌ 未安装
- pdf2image ❌ 未安装
- Pillow ❌ 未安装
- pyyaml ❌ 未安装（skill 验证需要）
- playwright ❌ 未安装

### 4.2 次优先：Skill 管理 API（内部管理接口）

```
POST /api/skills/init         — Body: JSON {name, path}        -> 创建目录结构
POST /api/skills/validate     — Body: JSON {path}              -> 校验结果
POST /api/skills/package      — Body: JSON {path, output_dir}  -> 返回 .skill 文件
```

### 4.3 暂缓：Morph PPT API（依赖外部工具）

需先确认 `officecli` 的安装和版本要求，才能设计 API 包装层。

### 4.4 重设计：社交媒体发布（需架构改造）

不建议直接包装为同步 API，需要：

1. 引入 Celery/Dramatiq 等任务队列
2. 浏览器 session 持久化管理
3. WebSocket 推送任务进度

---

## 五、双模式解耦架构建议

```
┌─────────────────────────────────────┐
│           AionUi 前端/客户端          │
└────────────┬──────────────────────┬─┘
             │ Electron IPC         │ HTTP REST
             ▼                      ▼
┌────────────────────┐  ┌──────────────────────┐
│   dist-server/     │  │   Python FastAPI      │
│   server.mjs       │  │   api-server/         │
│   (Node Express)   │  │   main.py             │
│   - Auth           │  │   - /api/pdf/*        │
│   - WebSocket      │  │   - /api/skills/*     │
│   - File system    │  │   - /api/ppt/*        │
│   - Extensions     │  │   - /api/social/*     │
└────────────────────┘  └──────────────────────┘
```

---

## 六、实施优先级与工作量估算

| 优先级 | 模块                     | 工作量 | 风险 | 备注                     |
| ------ | ------------------------ | ------ | ---- | ------------------------ |
| P0     | PDF 操作 API (9个端点)   | ~2天   | 低   | 函数直接包装，逻辑已成熟 |
| P1     | Skill 管理 API (3个端点) | ~1天   | 低   | 需权限控制               |
| P2     | Morph PPT API            | ~2天   | 中   | 依赖 officecli 安装      |
| P3     | 社交媒体发布 API         | ~5天   | 高   | 需任务队列、session 管理 |

---

## 七、结论

**当前最具可行性的 FastAPI 化目标是 PDF 技能脚本组**，共 9 个脚本，逻辑独立、无副作用依赖，
可在 2 天内完成完整 FastAPI 服务封装，并通过 `uvicorn` 或 `gunicorn` 独立部署。

建议下一步：

1. 安装 `pypdf pdf2image Pillow pyyaml` 及系统依赖 `poppler-utils`
2. 在 `dist-server/api-server/` 下创建 FastAPI 项目骨架
3. 从 `pdf/scripts/` 开始，逐步迁移到 FastAPI 路由
4. 与 server.mjs 通过 HTTP 内部调用集成

---

_本文档由 Hermes Agent 自动生成，路径: docs/api-abstraction-analysis.md_
