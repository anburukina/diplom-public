import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { login as apiLogin } from '../api';
import { useAuth } from '../auth';
import leafLogo from '../assets/листочек.png';

// Отображение страницы авторизации сотрудника.
export function Login() {
  const { employee, login } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [formKey, setFormKey] = useState(0);

  const from = location.state?.from || '/';

  /** Очистка полей формы после выхода пользователя. */
  const resetForm = () => {
    setFirstName('');
    setLastName('');
    setPassword('');
    setShowPassword(false);
    setError('');
    setFormKey((k) => k + 1);
  };

  useEffect(() => {
    if (location.state?.clear) {
      resetForm();
    }
  }, [location.state?.clear]);

  if (employee) {
    return <Navigate to="/" replace />;
  }

  /** Проверка формы и выполнение входа сотрудника. */
  const handleSubmit = async (event) => {
    event.preventDefault();
    const first = firstName.trim();
    const last = lastName.trim();
    if (!first || !last || !password) {
      setError('Заполните имя, фамилию и пароль');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = await apiLogin({ firstName: first, lastName: last, password });
      login(data);
      navigate(from, { replace: true });
    } catch {
      setError('Неверное имя, фамилия или пароль');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="brand-mark">
            <img src={leafLogo} alt="Листочек" />
          </div>
          <div>
            <div className="auth-title">Agro Control</div>
            <div className="muted">Вход для сотрудников</div>
          </div>
        </div>
        <form key={formKey} className="auth-form" onSubmit={handleSubmit}>
          <label className="input-group">
            <div className="label">Имя</div>
            <input
              className="input"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              autoComplete="given-name"
              placeholder="Введите имя"
            />
          </label>
          <label className="input-group">
            <div className="label">Фамилия</div>
            <input
              className="input"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              autoComplete="family-name"
              placeholder="Введите фамилию"
            />
          </label>
          <label className="input-group">
            <div className="label">Пароль</div>
            <div className="password-field">
              <input
                className="input input-with-icon"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="Введите пароль"
              />
              <button
                className={`password-toggle ${showPassword ? 'active' : ''}`}
                type="button"
                aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                title={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                onClick={() => setShowPassword((prev) => !prev)}
              >
                {showPassword ? (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M3 3l18 18M10.58 10.58A2 2 0 0 0 12 14a2 2 0 0 0 1.42-.58M9.88 4.24A10.64 10.64 0 0 1 12 4c6 0 10 8 10 8a18.9 18.9 0 0 1-4.32 5.36M6.23 6.23A18.7 18.7 0 0 0 2 12s4 8 10 8a10.7 10.7 0 0 0 4.06-.8"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M1.5 12s4-7.5 10.5-7.5S22.5 12 22.5 12 18.5 19.5 12 19.5 1.5 12 1.5 12Z"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    />
                    <circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" strokeWidth="2" />
                  </svg>
                )}
              </button>
            </div>
          </label>
          {error && <div className="pill danger">{error}</div>}
          <button className="btn primary auth-submit" type="submit" disabled={loading}>
            {loading ? 'Проверяем...' : 'Войти'}
          </button>
        </form>
      </div>
    </div>
  );
}
