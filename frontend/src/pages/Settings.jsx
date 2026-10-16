import { Topbar } from '../layout/Topbar';

// Отображение страницы настроек приложения.
export function Settings() {
  return (
    <div>
      <Topbar title="Настройки" subtitle="Заглушка для ролей и параметров" />
      <div className="panel">
        <div className="muted">Настройки ролей и доступа будут настроены на этапе интеграции с backend.</div>
      </div>
    </div>
  );
}
