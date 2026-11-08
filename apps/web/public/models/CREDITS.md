# Scene model credits

`places365-int8.onnx` and `places365-io.json` power the on-device indoor/outdoor check
(`src/features/sky/sceneClassifier.ts`). Built with `scripts/build_scene_model.py`.

- **Model:** Places365 ResNet18 by Bolei Zhou, Agata Lapedriza, Aditya Khosla, Aude Oliva and
  Antonio Torralba (MIT CSAIL), "Places: A 10 million Image Database for Scene Recognition",
  IEEE TPAMI 2017. https://github.com/CSAILVision/places365. Pretrained models are released
  under Creative Commons Attribution (CC BY); code under MIT.
- **ONNX conversion used as the source:** https://huggingface.co/mlboydaisuke/Places365-ResNet18-OpenVINO
  (`places_fp16.onnx`), quantized here to int8 (dynamic, uint8 weights).
- **Indoor/outdoor labels and category names:** `IO_places365.txt` and `categories_places365.txt`
  from the CSAILVision/places365 repository (1 = indoor, 2 = outdoor; stored here as indoor = 1/0).
