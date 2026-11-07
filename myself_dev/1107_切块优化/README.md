# 中文英文表格解析与切块优化

日期：2026-11-07。状态：**T1 和 T2 已验收，T3 待实施**。

采用 Docling＋RapidOCR 作为中文、英文常用文档的新主解析路径，保留结构化表格，按完整记录切块，再接入现有 BM25＋Qwen 向量检索。命中行组后能够回读所属表格，并在识别不足时核读原件页面。

## 位置与基线

- 容器目录：`/workspace/myself_dev/1107_切块优化`。
- 当前宿主机目录：`/home/xsy/projects/AutoRAG/myself_dev/1107_切块优化`。[Compose](../compose.yaml) 将仓库挂载到 `/workspace`，两条路径指向同一份文件。
- 编写基线：分支 `codex/github-pr-analysis-local-index`，提交 `0a1eeb6c`。后续以实际当前分支继续开发，不为匹配本文而切分支、同步 main 或创建 worktree。
- 已知机器：i7-10750H，6 核 12 线程，32 GB 内存，GTX 1650 Ti；截图时内存约占用 20.5 GB。Compose 声明 `cpus: 4`、`mem_limit: 8g`，实际生效限制须在实施时核实。
- 失败背景见[图片型成绩单问题记录](../问题记录/2026-11-07-图片型成绩单PDF解析失真与原件核读不足.md)。私人原件不复制到本目录。

## 轻量 SDD 阅读和执行顺序

| 文件 | 内容 |
| --- | --- |
| [SPEC.md](SPEC.md) | 需求、设计、数据和工具契约、范围与资源约束 |
| [PLAN.md](PLAN.md) | 三步实施、需求到验收的映射、发布门槛与证据要求 |
| [RESULTS.md](RESULTS.md) | T1 的识别质量、耗时、内存和复现入口 |

按 **冻结规格 → 分三步实现 → 验收后切换默认** 执行。实现若改变范围、数据契约或门槛，先更新规格；不把未运行的测试勾选为通过。准确率和性能收益以证据为准。

## 关键决定

1. 试用 Docling 时，PDF、DOCX、XLSX 走新解析器，扫描 PDF 和图片共用 RapidOCR PP-OCRv6 multilingual small。TableFormer ACCURATE 的结构结果用于生成 Markdown 与行组。
2. 现有 Qwen 嵌入、LanceDB、BM25、多轮证据恢复、来源授权和 datasource 联邦继续复用。
3. 保留 kordoc 的 HWP 系列兼容路径；旧 `.xls` 首版保留现有解析器，避免为迁移强制安装 LibreOffice。PPTX、EML、纯文本保持既有路由。
4. CPU、单解析进程、最多 4 个推理线程、页面缓冲 1；关闭可选视觉大模型和内容增强。T1 已在 4 CPU／8 GiB 容器中验证所测样本与 FastEmbed 共存，解析任务结束释放进程。
5. 新后端先显式试用，满足质量、兼容性和 8 GB 容器内共存门槛后，才切换常用格式的默认后端。

## T2 试用方式

使用 [T1 准备步骤](../../scripts/manual-qa/table-probe/README.md) 生成独立的 Python 环境和模型目录。启动 AutoRAG 的进程需要设置 `AUTORAG_DOCLING_PYTHON` 为该环境中 Python 的绝对路径，`AUTORAG_DOCLING_MODELS` 为预置模型目录的绝对路径。

```json
{
  "languages": ["zh-hans", "en"],
  "parserOptions": {
    "documentBackend": "docling",
    "ocr": { "enabled": true }
  }
}
```

在试用配置中加入上述字段，重启 TUI 并执行 `/index build`。构建通过后切换活动索引。回滚时改回 `"documentBackend": "kordoc"` 并重新执行 `/index build`。平时用 `/index refresh` 增量更新。`index inspect` 可核对结构哈希、行组正文、向量输入和 token 数。

当前产品默认值为 kordoc。结构化镜像按版本保存，活动索引通过清单定位准确的一对 Markdown 和结构文件。增量刷新先在候选索引上更新，有变化且通过后再发布。候选可复用旧向量。工作区目前保留已发布的旧代次，大语料会增加磁盘开销。
