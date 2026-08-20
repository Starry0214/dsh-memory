// dsh-memory-client 宿主半区：仅让插件出现在 cordis loader（真正的配置在 dsh-memory 主插件里）。
// 本包的 client 半区（./client）由 DSH 前端加载，往设置界面注册"记忆"配置行。
export function apply() {}
