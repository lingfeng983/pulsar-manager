// 第一条 import 必须是桥接注入：有些 store 在模块顶层就访问 window.electronAPI，
// ESM 会按 import 顺序深度优先求值，放后面就来不及了。
import './tauri-runtime';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
);
