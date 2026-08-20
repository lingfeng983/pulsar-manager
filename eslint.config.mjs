import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettierConfig from 'eslint-config-prettier';

// 排版类规则全部交给 prettier（见 .prettierrc.json：分号、120 列、4 空格缩进、
// 花括号内无空格、单参数箭头函数省略括号、尾随逗号）。ESLint 只负责
// prettier 管不到的代码质量与 React Hooks 约束，prettierConfig 放在最后
// 关掉两者冲突的规则。
export default tseslint.config(
    {
        ignores: ['dist/**', 'release/**', 'node_modules/**', '*.tsbuildinfo'],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['src/**/*.{ts,tsx}'],
        plugins: {
            react,
            'react-hooks': reactHooks,
        },
        settings: {
            react: {version: 'detect'},
        },
        rules: {
            // TypeScript 自己会做符号解析，no-undef 在 TS 文件里只会误报
            'no-undef': 'off',
            // 单行 if/for 也必须带花括号，避免后续加语句时改错作用域
            curly: ['error', 'all'],
            eqeqeq: ['error', 'smart'],
            'no-var': 'error',
            'prefer-const': 'error',
            'no-trailing-spaces': 'error',
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'warn',
            // 项目里大量与 Pulsar Admin API 交互的地方需要 any 兜底
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': [
                'error',
                {argsIgnorePattern: '^_', varsIgnorePattern: '^_'},
            ],
        },
    },
    prettierConfig,
);
