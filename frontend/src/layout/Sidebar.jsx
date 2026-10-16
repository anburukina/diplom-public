import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import leafLogo from '../assets/листочек.png';

const links = [
  { to: '/', label: 'Главная' },
  { to: '/zones', label: 'Зоны полива' },
  { to: '/sensors', label: 'Оборудование' },
  { to: '/measurements', label: 'Измерения' },
  { to: '/errors', label: 'Ошибки' },
];

/** Отображение основной навигации и блока выхода текущего сотрудника. */
export function Sidebar() {
  const { employee, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <img src={leafLogo} alt="Листочек" />
        </div>
        <div>
          <div>Agro Control</div>
          <div className="tiny">Гидро/Аэропоника</div>
        </div>
      </div>
      <div className="nav">
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.to === '/'}
            className={({ isActive }) => (isActive ? 'active' : undefined)}
          >
            <span>{link.label}</span>
          </NavLink>
        ))}
      </div>
      {employee && (
        <div className="sidebar-footer">
          <div className="tiny">Выполнен вход</div>
          <div className="sidebar-user">{employee.name}</div>
          <button
            className="btn"
            type="button"
            onClick={() => {
              logout();
              navigate('/login', { replace: true, state: { clear: true } });
            }}
          >
            Выйти
          </button>
        </div>
      )}
    </aside>
  );
}
