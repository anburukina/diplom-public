import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import './App.css';
import { Sidebar } from './layout/Sidebar';
import { useAuth } from './auth';
import { AlertNotifier } from './components/AlertNotifier';
import { NdviA2Notice } from './components/NdviA2Notice';

/** Загрузка страницы по требованию и адаптация именованного экспорта под React.lazy. */
const lazyPage = (loader, exportName) =>
  lazy(() => loader().then((module) => ({ default: module[exportName] })));

const Dashboard = lazyPage(() => import('./pages/Dashboard'), 'Dashboard');
const Zones = lazyPage(() => import('./pages/Zones'), 'Zones');
const ZoneDetails = lazyPage(() => import('./pages/ZoneDetails'), 'ZoneDetails');
const Sensors = lazyPage(() => import('./pages/Sensors'), 'Sensors');
const Errors = lazyPage(() => import('./pages/Errors'), 'Errors');
const Settings = lazyPage(() => import('./pages/Settings'), 'Settings');
const Measurements = lazyPage(() => import('./pages/Measurements'), 'Measurements');
const Login = lazyPage(() => import('./pages/Login'), 'Login');

/** Отображение состояния загрузки во время подгрузки страницы. */
function PageLoader({ fullScreen = false }) {
  const loader = <div className="panel page-loader">Загрузка...</div>;
  return fullScreen ? <div className="auth-shell">{loader}</div> : loader;
}

/** Выбор экрана входа или защищенной оболочки приложения по состоянию авторизации. */
function App() {
  const location = useLocation();
  const { employee } = useAuth();

  if (location.pathname === '/login') {
    return (
      <Suspense fallback={<PageLoader fullScreen />}>
        <Login />
      </Suspense>
    );
  }

  if (!employee) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main">
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/zones" element={<Zones />} />
            <Route path="/zones/:id" element={<ZoneDetails />} />
            <Route path="/sensors" element={<Sensors />} />
            <Route path="/measurements" element={<Measurements />} />
            <Route path="/errors" element={<Errors />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>
      <AlertNotifier />
      <NdviA2Notice />
    </div>
  );
}

export default App;
