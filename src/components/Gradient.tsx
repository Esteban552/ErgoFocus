import React from 'react';
import { ColorValue, StyleProp, ViewStyle } from 'react-native';
import { LinearGradient, LinearGradientProps } from 'expo-linear-gradient';
import { cssInterop } from 'nativewind';

cssInterop(LinearGradient, { className: 'style' });

type Direction = 'r' | 'l' | 't' | 'b' | 'tr' | 'tl' | 'br' | 'bl';

const START_END: Record<Direction, { start: [number, number]; end: [number, number] }> = {
  r: { start: [0, 0.5], end: [1, 0.5] },
  l: { start: [1, 0.5], end: [0, 0.5] },
  t: { start: [0.5, 1], end: [0.5, 0] },
  b: { start: [0.5, 0], end: [0.5, 1] },
  tr: { start: [0, 1], end: [1, 0] },
  tl: { start: [1, 1], end: [0, 0] },
  br: { start: [0, 0], end: [1, 1] },
  bl: { start: [1, 0], end: [0, 1] },
};

interface Props extends Omit<LinearGradientProps, 'colors' | 'start' | 'end'> {
  /** CSS direction letter, e.g. 'r' for bg-gradient-to-r, 'br' for -to-br */
  direction?: Direction;
  from?: string;
  to?: string;
  via?: string;
  colors?: string[];
  className?: string;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

/**
 * Native replacement for `bg-gradient-to-* from-* via-* to-*`.
 * NativeWind gradient utilities are web-only; use this component instead.
 */
export const Gradient: React.FC<Props> = ({
  direction = 'r',
  from,
  via,
  to,
  colors,
  className,
  style,
  children,
  ...rest
}) => {
  const resolved =
    colors ?? [from, via, to].filter((c): c is string => Boolean(c));
  const first = resolved[0] ?? '#000000';
  const second = resolved[1] ?? first;
  const colorTuple: [ColorValue, ColorValue, ...ColorValue[]] = [
    first,
    second,
    ...resolved.slice(2),
  ];
  const { start, end } = START_END[direction];
  return (
    <LinearGradient
      colors={colorTuple}
      start={start}
      end={end}
      className={className}
      style={style}
      {...rest}
    >
      {children}
    </LinearGradient>
  );
};
