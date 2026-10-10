use super::AppState;
use supercode_core::db::{AppearancePreferences, ThemePreference};

#[tauri::command]
pub async fn get_appearance_preferences(
    state: tauri::State<'_, AppState>,
) -> Result<AppearancePreferences, String> {
    state
        .store()
        .await
        .get_appearance_preferences()
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn save_appearance_preferences(
    state: tauri::State<'_, AppState>,
    preferences: AppearancePreferences,
) -> Result<(), String> {
    state
        .store()
        .await
        .save_appearance_preferences(preferences)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn appearance_ready(
    window: tauri::WebviewWindow,
    dark: bool,
    theme: ThemePreference,
) -> Result<(), String> {
    window
        .set_theme(match theme {
            ThemePreference::System => None,
            ThemePreference::Light => Some(tauri::Theme::Light),
            ThemePreference::Dark => Some(tauri::Theme::Dark),
        })
        .map_err(|e| e.to_string())?;
    let color = if dark {
        tauri::window::Color(24, 25, 29, 255)
    } else {
        tauri::window::Color(250, 250, 252, 255)
    };
    window
        .set_background_color(Some(color))
        .map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())
}
