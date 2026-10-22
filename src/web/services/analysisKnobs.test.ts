import { withKnob } from './analysisKnobs';

describe('withKnob', () => {
  const saved = { enabledCameras: ['slavija'], analysisFps: 4, overlayModel: 'yolo26n', overlayConfidence: 0.3, passageRetentionDays: 90 };

  it('sets a number knob from its select value', () => {
    expect(withKnob(saved, 'analysisFps', '1.5')).toEqual({ ...saved, analysisFps: 1.5 });
  });

  it('sets the model as a string', () => {
    expect(withKnob(saved, 'overlayModel', 'yolo26m').overlayModel).toBe('yolo26m');
  });

  it('keeps 0 ("forever") for retention', () => {
    expect(withKnob(saved, 'passageRetentionDays', '0').passageRetentionDays).toBe(0);
  });

  it.each(['analysisFps', 'overlayModel', 'overlayConfidence', 'passageRetentionDays'] as const)(
    'the default option (first, value "") removes %s from what is sent to the server',
    (key) => {
      const next = withKnob(saved, key, '');
      expect(key in next).toBe(false);
      expect(JSON.parse(JSON.stringify(next))).not.toHaveProperty(key);
      expect(next.enabledCameras).toEqual(['slavija']);
    },
  );

  it('does not change the settings it was given', () => {
    withKnob(saved, 'analysisFps', '');
    expect(saved.analysisFps).toBe(4);
  });
});
