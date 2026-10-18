'use strict';
exports.load = function () {};
exports.unload = function () {};
exports.methods = {
  async inspect() {
    return Editor.Message.request('scene', 'execute-scene-script', { name: 'game-project-tools', method: 'inspect', args: [] });
  },
  async generate() {
    return Editor.Message.request('scene', 'execute-scene-script', { name: 'game-project-tools', method: 'generate', args: [] });
  },
};
