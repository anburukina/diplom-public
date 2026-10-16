import { createContext, useContext, useMemo, useState } from 'react';

const AUTH_STORAGE_KEY = 'employeeAuth';

// Чтение данных авторизованного сотрудника из localStorage.
const readStoredEmployee = () => {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.id) return null;
    return parsed;
  } catch {
    return null;
  }
};

// Сохранение данных авторизованного сотрудника в localStorage.
const writeStoredEmployee = (employee) => {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(employee));
};

// Удаление данных авторизованного сотрудника из localStorage.
const clearStoredEmployee = () => {
  localStorage.removeItem(AUTH_STORAGE_KEY);
};

const AuthContext = createContext({ employee: null, login: () => {}, logout: () => {} });

// Хранение состояния авторизации и передача его дочерним компонентам.
export function AuthProvider({ children }) {
  const [employee, setEmployee] = useState(() => readStoredEmployee());

  // Сохранение сотрудника после успешной авторизации.
  const login = (emp) => {
    if (!emp) return;
    setEmployee(emp);
    writeStoredEmployee(emp);
  };

  // Выход сотрудника из системы.
  const logout = () => {
    setEmployee(null);
    clearStoredEmployee();
  };

  const value = useMemo(() => ({ employee, login, logout }), [employee]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// Получение данных авторизации из React-контекста.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthContext);
}
