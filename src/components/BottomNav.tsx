import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { LayoutDashboard, Wind, TrendingUp, User } from 'lucide-react-native';
import { TabType } from '../types';

interface Props {
  currentTab: TabType;
  onTabChange: (tab: TabType) => void;
}

export const BottomNav: React.FC<Props> = ({ currentTab, onTabChange }) => {
  const tabs: { id: TabType; label: string; icon: React.ElementType }[] = [
    { id: 'dashboard', label: 'Resumen', icon: LayoutDashboard },
    { id: 'ambient', label: 'Ambiente', icon: Wind },
    { id: 'trends', label: 'Tendencias', icon: TrendingUp },
    { id: 'profile', label: 'Perfil', icon: User },
  ];

  return (
    <View className="absolute bottom-3 left-4 right-4 z-40">
      <View className="flex-row items-center justify-around px-3 py-2 bg-white/90 border border-slate-200/90 rounded-full">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = currentTab === tab.id;

          return (
            <Pressable
              key={tab.id}
              onPress={() => onTabChange(tab.id)}
              className={`relative flex-col items-center justify-center min-w-[72px] py-1 px-2 rounded-full ${
                isActive ? 'text-[#2563eb]' : 'text-[#64748b]'
              }`}
            >
              <Icon
                size={20}
                color={isActive ? '#2563eb' : '#64748b'}
                strokeWidth={isActive ? 2.4 : 1.8}
              />
              <Text
                className={`text-[10px] mt-0.5 tracking-tight ${
                  isActive
                    ? 'font-sans-bold text-[#2563eb]'
                    : 'font-sans-medium text-[#64748b]'
                }`}
              >
                {tab.label}
              </Text>
              {isActive && (
                <View className="absolute -bottom-0.5 w-1 h-1 rounded-full bg-[#2563eb]" />
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
};