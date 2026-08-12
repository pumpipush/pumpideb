// Minimal type declarations for Google Identity Services (GSI)
interface Window {
  google?: {
    accounts: {
      id: {
        initialize: (config: {
          client_id: string;
          callback: (response: { credential: string }) => void;
          ux_mode?: "popup" | "redirect";
          auto_select?: boolean;
        }) => void;
        renderButton: (
          parent: HTMLElement,
          options: {
            type?: "standard" | "icon";
            theme?: "outline" | "filled_blue" | "filled_black";
            size?: "large" | "medium" | "small";
            text?: string;
          }
        ) => void;
        prompt: (
          momentListener?: (notification: { getMomentType: () => string }) => void
        ) => void;
      };
    };
  };
}
