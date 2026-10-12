# Models

Model files are **not** stored in this repository (they are several GB and have their own licences).

Download a GGUF build of Qwen2.5-3B-Instruct into this folder:

```bash
pip install -U huggingface_hub
hf download Qwen/Qwen2.5-3B-Instruct-GGUF qwen2.5-3b-instruct-q4_k_m.gguf --local-dir models
# older huggingface_hub versions: huggingface-cli download ... (same arguments)
```

Then set `MODEL_FILE` in `.env` to the file name. Any other GGUF chat model that llama.cpp supports also works.
Check the model's licence before using it in a commercial setting.
