# Findings — T-20260807-feature-verification-policy

- focused baseline 必须允许候选内容前进，但只在 attestation、manifest/控制面兼容、baseline commit 可达且为当前 `HEAD` 祖先时复用未受影响 PASS。
- baseline 的“完整执行”必须同时审计 incremental cache 列表和每个 check 的 `cached` 标记，不能依赖其中单一表示。
- suite inclusion 的多 owner 歧义不仅发生在被显式 selected 的 child；两个执行根共享任何 descendant 都会导致重复执行，必须 fail-closed。
- 完成态需求门禁应把缺失 spec/plan 当作结构化缺失内容拒绝，不能依赖文件读取异常。
