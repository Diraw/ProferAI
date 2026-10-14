import { Toaster as Sonner } from "sonner"

type ToasterProps = React.ComponentProps<typeof Sonner>

/**
 * 通用 Toaster 基元（纯 UI）。主题默认为 "system"；桌面壳应传入
 * resolvedThemeAtom 解析出的 light/dark 以与皮肤系统保持一致。
 */
const Toaster = ({ theme = "system", ...props }: ToasterProps) => {
  return (
    <Sonner
      theme={theme}
      position="top-center"
      offset={58}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-surface-raised group-[.toaster]:text-foreground group-[.toaster]:border-surface-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-control group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
