# AI 质量评估

日常 `npm test` 不调用模型、不产生 API 费用。它检查截断、字段形状、答案一致性、噪声解析、复习与计划约束。

这里另提供 Promptfoo 自定义 provider，直接加载当前生产 `generateReflection`，不是复制一份提示词。样例全部为合成题目，既不读正式数据库、应用密钥，也不写 Obsidian。

付费评估需要使用者自行提供 `STUDY_EVAL_API_KEY`、`STUDY_EVAL_BASE_URL`、`STUDY_EVAL_MODEL`，并明确设置 `STUDY_EVAL_ALLOW_PAID=yes`。未设置时 provider 拒绝调用。接口会收到样例题目，调用可能重试并计费；不要提交 `.env` 或密钥。配置不包含 LLM 裁判，断言只是初筛，不能替代解题人工核验。

使用可信的本地 Promptfoo 安装执行：`promptfoo eval -c evals/promptfooconfig.yaml --max-concurrency 1`。本次没有安装或执行付费评估。后续增加图表评估前需先准备脱敏图像并单独授权费用。

参考：[官方 Javascript Provider](https://www.promptfoo.dev/docs/providers/custom-api/)。
