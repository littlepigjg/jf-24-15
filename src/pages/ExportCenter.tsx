import { useEffect, useState, useRef, useCallback } from "react";
import {
  Download,
  Archive,
  FileSpreadsheet,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
  Trash2,
  QrCode as QrIcon,
  Search,
  ChevronLeft,
  ChevronRight,
  History,
  FileImage,
  Pause,
  Play,
  Zap,
  Timer,
  Gauge,
} from "lucide-react";
import { api } from "@/lib/api";
import type { QrCode, PagedResult, ExportTask, ExportTaskStatus, ExportFormat } from "@shared/types";

const mockQrList: PagedResult<QrCode> = {
  items: Array.from({ length: 10 }, (_, i) => ({
    id: `qr-${i + 1}`,
    name: `示例二维码 ${i + 1}`,
    type: i % 2 === 0 ? "dynamic" : "static",
    targetUrl: `https://example.com/page/${i + 1}`,
    shortCode: `sh${1000 + i}`,
    size: 256,
    foreground: "#0F172A",
    background: "#FFFFFF",
    errorLevel: "M",
    enabled: i !== 3,
    scanCount: Math.floor(Math.random() * 5000),
    createdAt: new Date(Date.now() - i * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - i * 43200000).toISOString(),
  })),
  total: 128,
  page: 1,
  pageSize: 10,
};

const statusMap: Record<ExportTaskStatus, { label: string; cls: string; icon: typeof CheckCircle2 }> = {
  pending: { label: "等待中", cls: "tag-orange", icon: Clock },
  running: { label: "处理中", cls: "tag-blue", icon: Loader2 },
  paused: { label: "已暂停", cls: "tag-yellow", icon: Pause },
  completed: { label: "已完成", cls: "tag-green", icon: CheckCircle2 },
  failed: { label: "失败", cls: "tag-red", icon: Trash2 },
};

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours} 小时 ${mins} 分`;
}

function formatSpeed(speed: number): string {
  if (speed < 1) return `${Math.round(speed * 100) / 100} 条/秒`;
  if (speed < 1000) return `${Math.round(speed)} 条/秒`;
  return `${(speed / 1000).toFixed(2)} K 条/秒`;
}

export default function ExportCenter() {
  const [qrList, setQrList] = useState<PagedResult<QrCode>>(mockQrList);
  const [tasks, setTasks] = useState<ExportTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const pollTimerRef = useRef<number | null>(null);

  const fetchTasks = useCallback(async () => {
    try {
      const r = await api.listExportTasks();
      setTasks(r.items as unknown as ExportTask[]);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    api
      .listQrCodes({ page, pageSize: 10 })
      .then(setQrList)
      .catch(() => setQrList({ ...mockQrList, page }))
      .finally(() => setLoading(false));
    fetchTasks().finally(() => setTasksLoading(false));
  }, [page, fetchTasks]);

  useEffect(() => {
    const hasRunning = tasks.some((t) => t.status === "running");
    if (hasRunning) {
      pollTimerRef.current = window.setInterval(() => {
        fetchTasks();
      }, 2000);
    } else if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, [tasks, fetchTasks]);

  const totalPages = Math.ceil(qrList.total / qrList.pageSize);
  const allSelected = qrList.items.length > 0 && qrList.items.every((q) => selected.has(q.id));

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        qrList.items.forEach((q) => next.delete(q.id));
      } else {
        qrList.items.forEach((q) => next.add(q.id));
      }
      return next;
    });
  };

  const handleCreateExportTask = async (format: ExportFormat) => {
    if (selected.size === 0) {
      alert("请至少选择一个二维码");
      return;
    }
    setExporting(true);
    try {
      await api.createExportTask({
        ids: Array.from(selected),
        format,
        name: `导出_${format}_${new Date().toLocaleString("zh-CN")}`,
      });
      await fetchTasks();
    } catch (e) {
      alert("创建导出任务失败，请稍后重试");
    } finally {
      setExporting(false);
    }
  };

  const handlePauseTask = async (taskId: string) => {
    try {
      await api.pauseExportTask(taskId);
      await fetchTasks();
    } catch (e) {
      alert("暂停失败");
    }
  };

  const handleResumeTask = async (taskId: string) => {
    try {
      await api.resumeExportTask(taskId);
      await fetchTasks();
    } catch (e) {
      alert("恢复失败");
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    if (!confirm("确定要删除这个导出任务吗？")) return;
    try {
      await api.deleteExportTask(taskId);
      await fetchTasks();
    } catch (e) {
      alert("删除失败");
    }
  };

  const handleDownloadTask = async (task: ExportTask) => {
    if (task.status !== "completed" || !task.downloadUrl) return;
    try {
      const blob = await api.downloadExportFile(task.downloadUrl);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${task.name || task.id}.${task.format === "zip" ? "zip" : "csv"}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      alert("下载失败");
    }
  };

  const clearSelected = () => setSelected(new Set());

  const getProgress = (task: ExportTask) => {
    if (task.progress && task.progress.averageSpeed > 0) {
      return {
        percentage: task.progress.percentage,
        completedItems: task.progress.processedItems,
        speed: task.progress.averageSpeed,
        remainingSeconds: task.progress.estimatedRemainingSeconds,
        elapsedSeconds: task.progress.activeElapsedSeconds,
      };
    }
    const completed = task.chunks.filter((c) => c.status === "completed").length;
    const percentage = task.totalChunks > 0 ? (completed / task.totalChunks) * 100 : 0;

    const completedItems = task.chunks
      .filter((c) => c.status === "completed")
      .reduce((sum, c) => sum + (c.endIndex - c.startIndex), 0);

    const activeMs = task.activeTimeMs || 0;
    const activeSeconds = Math.max(1, Math.ceil(activeMs / 1000));
    const speed = activeSeconds > 0 ? completedItems / activeSeconds : 0;
    const remainingItems = task.totalItems - completedItems;
    const remainingSeconds = speed > 0 ? Math.ceil(remainingItems / speed) : 0;

    return {
      percentage: Math.round(percentage * 100) / 100,
      completedItems,
      speed: Math.round(speed * 100) / 100,
      remainingSeconds,
      elapsedSeconds: activeSeconds,
    };
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-display font-bold text-white flex items-center gap-2">
            <Download className="w-6 h-6 text-brand-400" />
            导出中心
          </h1>
          <p className="text-dark-400 mt-1 text-sm">
            选择二维码批量导出，支持分片并行处理、断点续传和进度追踪
          </p>
        </div>
        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <span className="tag-blue">
              已选择 {selected.size} 个
              <button onClick={clearSelected} className="ml-2 hover:text-white opacity-70 hover:opacity-100">
                ×
              </button>
            </span>
          )}
          <button
            onClick={() => handleCreateExportTask("zip")}
            disabled={selected.size === 0 || exporting}
            className="btn-primary"
          >
            {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Archive className="w-4 h-4" />}
            导出 ZIP（图片）
          </button>
          <button
            onClick={() => handleCreateExportTask("csv")}
            disabled={selected.size === 0 || exporting}
            className="btn-secondary"
          >
            <FileSpreadsheet className="w-4 h-4" />
            导出 CSV
          </button>
        </div>
      </div>

      <div className="card p-4 border-brand-500/20">
        <div className="flex items-center gap-2 text-sm text-brand-300 mb-3">
          <FileImage className="w-4 h-4" />
          选择要导出的二维码
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-dark-500" />
            <input
              type="text"
              placeholder="搜索名称、短码..."
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              className="input pl-9"
            />
          </div>
          <div className="text-xs text-dark-400">
            共 <span className="text-white font-semibold">{qrList.total}</span> 个
          </div>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-dark-900/60">
              <tr>
                <th className="table-head w-10">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    className="w-4 h-4 rounded border-dark-600 bg-dark-900 text-brand-500 focus:ring-brand-500 focus:ring-offset-dark-900"
                  />
                </th>
                <th className="table-head">二维码</th>
                <th className="table-head">类型</th>
                <th className="table-head">短码</th>
                <th className="table-head">扫码次数</th>
                <th className="table-head">创建时间</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="table-cell text-center py-12 text-dark-500">
                    加载中...
                  </td>
                </tr>
              ) : qrList.items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="table-cell text-center py-12 text-dark-500">
                    <QrIcon className="w-12 h-12 mx-auto mb-2 opacity-30" />
                    <p>暂无数据</p>
                  </td>
                </tr>
              ) : (
                qrList.items.map((qr) => {
                  const checked = selected.has(qr.id);
                  return (
                    <tr
                      key={qr.id}
                      className={`table-row cursor-pointer ${checked ? "bg-brand-500/5" : ""}`}
                      onClick={() => toggleSelect(qr.id)}
                    >
                      <td className="table-cell" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSelect(qr.id)}
                          className="w-4 h-4 rounded border-dark-600 bg-dark-900 text-brand-500 focus:ring-brand-500 focus:ring-offset-dark-900 cursor-pointer"
                        />
                      </td>
                      <td className="table-cell">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-lg bg-white p-1 flex-shrink-0 border border-dark-700">
                            <QrIcon className="w-full h-full text-dark-900" />
                          </div>
                          <span className={`font-medium truncate ${checked ? "text-brand-300" : "text-white"}`}>
                            {qr.name}
                          </span>
                        </div>
                      </td>
                      <td className="table-cell">
                        {qr.type === "dynamic" ? (
                          <span className="tag-blue">动态码</span>
                        ) : (
                          <span className="tag-gray">静态码</span>
                        )}
                      </td>
                      <td className="table-cell font-mono text-sm text-brand-400">/{qr.shortCode}</td>
                      <td className="table-cell font-semibold text-white">{qr.scanCount.toLocaleString()}</td>
                      <td className="table-cell text-dark-400 text-xs whitespace-nowrap">
                        {new Date(qr.createdAt).toLocaleDateString("zh-CN")}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between px-4 py-4 border-t border-dark-700 flex-wrap gap-4">
          <p className="text-sm text-dark-400">
            第 {(page - 1) * qrList.pageSize + 1} - {Math.min(page * qrList.pageSize, qrList.total)} 条
          </p>
          <div className="flex items-center gap-1">
            <button
              className="btn-secondary px-2.5 py-1.5 disabled:opacity-40"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              let pNum = i + 1;
              if (totalPages > 5) {
                if (page > 3) pNum = page - 2 + i;
                if (page > totalPages - 2) pNum = totalPages - 4 + i;
              }
              if (pNum < 1 || pNum > totalPages) return null;
              return (
                <button
                  key={pNum}
                  onClick={() => setPage(pNum)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                    pNum === page
                      ? "bg-brand-gradient text-white shadow-glow-sm"
                      : "bg-dark-700 text-dark-300 hover:bg-dark-600"
                  }`}
                >
                  {pNum}
                </button>
              );
            })}
            <button
              className="btn-secondary px-2.5 py-1.5 disabled:opacity-40"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-5 py-4 border-b border-dark-700 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-brand-400" />
            <h3 className="font-semibold text-white">导出任务</h3>
            <span className="tag-gray">共 {tasks.length} 个</span>
          </div>
          <button
            onClick={() => {
              setTasksLoading(true);
              fetchTasks().finally(() => setTasksLoading(false));
            }}
            className="btn-ghost text-sm"
          >
            <RefreshCw className={`w-4 h-4 ${tasksLoading ? "animate-spin" : ""}`} />
            刷新
          </button>
        </div>
        <div className="overflow-x-auto">
          {tasks.length === 0 ? (
            <div className="py-16 text-center text-dark-500">
              <History className="w-12 h-12 mx-auto mb-2 opacity-30" />
              <p>暂无导出任务</p>
              <p className="text-xs mt-1">选择二维码后点击导出按钮创建任务</p>
            </div>
          ) : (
            <table className="w-full">
              <thead className="bg-dark-900/40">
                <tr>
                  <th className="table-head">任务名称</th>
                  <th className="table-head">格式</th>
                  <th className="table-head">进度</th>
                  <th className="table-head">速度</th>
                  <th className="table-head">剩余时间</th>
                  <th className="table-head">状态</th>
                  <th className="table-head text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => {
                  const s = statusMap[task.status];
                  const StatusIcon = s.icon;
                  const progress = getProgress(task);

                  return (
                    <tr key={task.id} className="table-row">
                      <td className="table-cell">
                        <p className="font-medium text-white">{task.name}</p>
                        <p className="text-xs text-dark-500 font-mono mt-0.5">
                          {task.totalItems.toLocaleString()} 条 · {task.totalChunks} 分片
                        </p>
                      </td>
                      <td className="table-cell">
                        <span className="tag-gray">
                          {task.format === "zip" ? (
                            <Archive className="w-3 h-3" />
                          ) : (
                            <FileSpreadsheet className="w-3 h-3" />
                          )}
                          {task.format === "zip" ? "ZIP" : task.format === "csv" ? "CSV" : task.format}
                        </span>
                      </td>
                      <td className="table-cell min-w-[180px]">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 bg-dark-800 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-300 ${
                                task.status === "failed"
                                  ? "bg-red-500"
                                  : task.status === "paused"
                                  ? "bg-yellow-500"
                                  : "bg-brand-gradient"
                              }`}
                              style={{ width: `${progress.percentage}%` }}
                            />
                          </div>
                          <span className="text-xs text-dark-300 w-12 text-right tabular-nums">
                            {progress.percentage}%
                          </span>
                        </div>
                      </td>
                      <td className="table-cell">
                        <div className="flex items-center gap-1.5 text-sm text-dark-300">
                          <Gauge className="w-3.5 h-3.5 text-dark-500" />
                          <span className="tabular-nums">{formatSpeed(progress.speed)}</span>
                        </div>
                      </td>
                      <td className="table-cell">
                        <div className="flex items-center gap-1.5 text-sm text-dark-300">
                          <Timer className="w-3.5 h-3.5 text-dark-500" />
                          <span className="tabular-nums">
                            {task.status === "completed"
                              ? formatDuration(progress.elapsedSeconds)
                              : task.status === "running"
                              ? formatDuration(progress.remainingSeconds)
                              : "-"}
                          </span>
                        </div>
                      </td>
                      <td className="table-cell">
                        <span className={s.cls}>
                          <StatusIcon className={`w-3 h-3 ${task.status === "running" ? "animate-spin" : ""}`} />
                          {s.label}
                        </span>
                      </td>
                      <td className="table-cell text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {task.status === "running" && (
                            <button
                              onClick={() => handlePauseTask(task.id)}
                              className="btn-secondary text-xs px-2 py-1"
                              title="暂停"
                            >
                              <Pause className="w-3.5 h-3.5" />
                              暂停
                            </button>
                          )}
                          {task.status === "paused" && (
                            <button
                              onClick={() => handleResumeTask(task.id)}
                              className="btn-primary text-xs px-2 py-1"
                              title="恢复"
                            >
                              <Play className="w-3.5 h-3.5" />
                              恢复
                            </button>
                          )}
                          {task.status === "completed" && (
                            <button
                              onClick={() => handleDownloadTask(task)}
                              className="btn-primary text-xs px-2 py-1"
                            >
                              <Download className="w-3.5 h-3.5" />
                              下载
                            </button>
                          )}
                          {(task.status === "failed" || task.status === "completed" || task.status === "paused") && (
                            <button
                              onClick={() => handleDeleteTask(task.id)}
                              className="btn-ghost text-xs px-2 py-1 text-red-400 hover:text-red-300"
                              title="删除"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card p-5 bg-dark-900/50 border-dark-700">
        <div className="flex items-start gap-3">
          <Zap className="w-5 h-5 text-brand-400 flex-shrink-0 mt-0.5" />
          <div>
            <h4 className="font-semibold text-white mb-2">功能说明</h4>
            <ul className="text-sm text-dark-400 space-y-1">
              <li>• <span className="text-brand-300">分片并行处理</span>：将大量数据分成多个分片同时处理，提升导出效率</li>
              <li>• <span className="text-brand-300">断点续传</span>：支持随时暂停和恢复导出任务，已完成的分片不会重复处理</li>
              <li>• <span className="text-brand-300">实时进度</span>：实时显示导出进度、处理速度和预估剩余时间</li>
              <li>• <span className="text-brand-300">自动重试</span>：失败的分片会自动重试，最多重试 3 次</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
