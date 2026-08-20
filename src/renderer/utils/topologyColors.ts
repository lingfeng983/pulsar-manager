// 拓扑图与图例共用的配色。两处拓扑图（首页概览 / 集群拓扑）此前各自硬编码同一批
// 色值，图例色块又抄了一遍，改配色时容易漏改，这里统一收口。
export const TOPOLOGY_COLORS = {
  // 集群 / Broker 主色，同时表示"在线"
  primary: '#409EFF',
  // Broker / Topic 绿色，同时表示"健康"
  success: '#67C23A',
  // Topic / Partition 橙色
  warning: '#E6A23C',
  // Subscription 红色，同时表示"离线"
  danger: '#F56C6C',
  // 连线灰
  edge: '#909399',
  // 节点标签灰
  label: '#666',
}
