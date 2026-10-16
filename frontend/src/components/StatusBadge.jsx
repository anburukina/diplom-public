/** Преобразование технического статуса в визуальный бейдж. */
export default function StatusBadge({ status, children }) {
  const map = {
    ok: 'success',
    normal: 'success',
    warn: 'warning',
    warning: 'warning',
    critical: 'danger',
  };
  const tone = map[status] || 'success';
  return <span className={`pill ${tone}`}>{children ?? status}</span>;
}
