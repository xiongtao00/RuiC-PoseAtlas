export const roles = {
  pose: '姿势',
  outfit: '穿搭',
  person: '长相',
  body: '身材',
  background: '背景',
};

export function makeCatalog(poses, costumes, faces) {
  const categories = Object.fromEntries(costumes.categories.map(item => [item.key, item.names.zh]));
  const angles = Object.fromEntries(poses.angles.map(item => [item.key, item.names.zh]));
  return {
    pose: poses.poses.flatMap(pose => pose.variants.map(image => ({
      id: `${pose.id}:${image.angle}`,
      label: `${pose.names.zh} · ${angles[image.angle]}`,
      thumb: image.thumb,
      full: image.full,
    }))),
    outfit: costumes.costumes.map(item => ({
      id: item.id,
      label: `${categories[item.cat]} · ${item.id}`,
      keywords: item.tags.join(' '),
      thumb: item.thumb,
      full: item.image,
    })),
    person: faces.images.map(item => ({
      id: item.id,
      label: `${item.sec === 'face' ? '脸部' : '造型'} · ${item.id}`,
      thumb: item.thumb,
      full: item.full,
      remote: item.full_remote,
    })),
  };
}
