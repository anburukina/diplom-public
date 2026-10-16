/** Отображение верхней строки страницы с заголовком, подписью и действиями. */
export function Topbar({ title, subtitle, actions }) {
  return (
    <div className="topbar">
      <div>
        {subtitle && <div className="breadcrumbs">{subtitle}</div>}
        <div className="title">{title}</div>
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}
