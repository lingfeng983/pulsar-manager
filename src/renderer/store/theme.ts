import {create} from 'zustand';

export type ThemeType = 'light' | 'dark' | 'eyeCare';

interface ThemeState {
    theme: ThemeType;
    setTheme: (theme: ThemeType) => void;
}

export const useThemeStore = create<ThemeState>(set => ({
    theme: 'light',
    setTheme: theme => set({theme}),
}));
