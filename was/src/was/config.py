from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

TYPESAFE_BASE_URL = "https://api.typesafe.ai"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8-sig",
        extra="ignore",
        hide_input_in_errors=True,
        str_strip_whitespace=True,
    )

    host: str = Field(default="127.0.0.1", min_length=1, validation_alias="WAS_HOST")
    port: int = Field(default=8765, ge=1, le=65535, validation_alias="WAS_PORT")

    jev_api_key: SecretStr | None = Field(default=None, validation_alias="TYPESAFE_API_KEY")
    jev_model: str = Field(default="jev-1.14.0", min_length=1, validation_alias="JEV_MODEL")
    jev_timeout_seconds: float = Field(
        default=10.0, gt=0, allow_inf_nan=False, validation_alias="JEV_TIMEOUT_SECONDS"
    )
    jev_max_retries: int = Field(default=0, ge=0, validation_alias="JEV_MAX_RETRIES")

    @field_validator("jev_api_key", mode="before")
    @classmethod
    def normalize_key(cls, value: str | SecretStr | None) -> str | SecretStr | None:
        if isinstance(value, str):
            return value.strip() or None
        return value
