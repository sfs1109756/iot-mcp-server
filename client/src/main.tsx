import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initToken, installAuthFetch } from './auth';
import { ErrorBoundary } from './components/ErrorBoundary';
import './base.css';
import './app.css';

initToken();
installAuthFetch();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
