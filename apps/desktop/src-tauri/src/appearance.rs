use super::AppState;
use supercode_core::db::{AppearancePreferences, MotionPreferences, ThemePreference};

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

#[tauri::command]
pub async fn get_motion_preferences(
    state: tauri::State<'_, AppState>,
) -> Result<MotionPreferences, String> {
    state
        .store()
        .await
        .get_motion_preferences()
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn save_motion_preferences(
    state: tauri::State<'_, AppState>,
    preferences: MotionPreferences,
) -> Result<(), String> {
    state
        .store()
        .await
        .save_motion_preferences(preferences)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_layout_preferences(
    state: tauri::State<'_, AppState>,
) -> Result<supercode_core::db::LayoutPreferences, String> {
    state
        .store()
        .await
        .get_layout_preferences()
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn save_layout_preferences(
    state: tauri::State<'_, AppState>,
    preferences: supercode_core::db::LayoutPreferences,
) -> Result<(), String> {
    state
        .store()
        .await
        .save_layout_preferences(preferences)
        .await
        .map_err(|e| e.to_string())
}

// Deliberately serialize only UI preferences; never the Store or model configuration.
pub async fn bootstrap_preferences(store: &supercode_core::db::Store) -> serde_json::Value {
    fn loaded<T: serde::Serialize + Default>(
        value: supercode_core::error::Result<T>,
    ) -> serde_json::Value {
        match value {
            Ok(preferences) => serde_json::json!({ "preferences": preferences, "error": null }),
            Err(error) => {
                serde_json::json!({ "preferences": T::default(), "error": error.to_string() })
            }
        }
    }
    serde_json::json!({
        "appearance": loaded(store.get_appearance_preferences().await),
        "motion": loaded(store.get_motion_preferences().await),
        "layout": loaded(store.get_layout_preferences().await),
    })
}

pub fn bootstrap_failure(error: String) -> serde_json::Value {
    serde_json::json!({
        "appearance": { "preferences": AppearancePreferences::default(), "error": error },
        "motion": { "preferences": MotionPreferences::default(), "error": error },
        "layout": { "preferences": supercode_core::db::LayoutPreferences::default(), "error": error },
    })
}

#[cfg(test)]
mod bootstrap_tests {
    use super::*;
    #[tokio::test]
    async fn startup_snapshot_preserves_saved_preferences_and_has_only_ui_fields() {
        let store = supercode_core::db::Store::open_in_memory().await.unwrap();
        store
            .save_appearance_preferences(AppearancePreferences {
                theme: ThemePreference::Dark,
            })
            .await
            .unwrap();
        let snapshot = bootstrap_preferences(&store).await;
        assert_eq!(snapshot["appearance"]["preferences"]["theme"], "dark");
        assert!(snapshot["appearance"]["error"].is_null());
        assert_eq!(snapshot.as_object().unwrap().len(), 3);
        assert_eq!(snapshot["layout"]["preferences"]["terminal_height"], 224);
        assert_eq!(snapshot["motion"]["preferences"]["motion"], "system");
    }
    #[test]
    fn startup_read_failure_keeps_defaults_and_marks_every_provider_unloaded() {
        let snapshot = bootstrap_failure("fixture database unavailable".into());
        for name in ["appearance", "motion", "layout"] {
            assert_eq!(snapshot[name]["error"], "fixture database unavailable");
            assert!(snapshot[name]["preferences"].is_object());
        }
        assert_eq!(snapshot["appearance"]["preferences"]["theme"], "system");
    }
}
