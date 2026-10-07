// Builds the Punjab 2027 pitch deck in Punjabi and Hindi: node build.cjs
// Text is a first draft: have a native speaker review it before it is shown to a client.
const pptxgen = require('pptxgenjs');

const FONT = 'Nirmala UI'; // ships with Windows and covers both Gurmukhi and Devanagari
const NAVY = '1E2240', GOLD = 'E8A317', LEAF = '2F7D5B', PAPER = 'F6F7FB', INK = '26203F', SOFT = '5B5575';

const DECKS = {
  pa: {
    file: 'Punjab2027_Pitch_Punjabi.pptx', lang: 'pa-IN',
    title: 'ਪੂਰੀ ਮੁਹਿੰਮ, ਇੱਕ ਥਾਂ', sub: 'ਪੰਜਾਬ ਵਿਧਾਨ ਸਭਾ 2027 ਲਈ ਚੋਣ ਮੁਹਿੰਮ ਪਲੇਟਫਾਰਮ', by: 'Wayne E Solutions',
    slides: [
      ['ਮੁਹਿੰਮ ਦੇ ਕੰਮ ਇੱਕੋ ਪਲੇਟਫਾਰਮ ਤੇ', ['ਵੋਟਰ ਨਾਲ ਸੰਪਰਕ: ਪੰਨਾ, ਸਵਾਲ-ਜਵਾਬ, ਕਾਲਾਂ ਅਤੇ SMS', 'ਜ਼ਮੀਨੀ ਕੰਮ: ਬੂਥ ਵਰਕਰ, ਸਮਾਗਮ, ਵਲੰਟੀਅਰ', 'ਖ਼ਰਚਾ: ਚੋਣ ਖ਼ਰਚੇ ਦਾ ਰਜਿਸਟਰ ਅਤੇ ਰਸੀਦਾਂ', 'ਨਤੀਜੇ: ਵੋਟਿੰਗ ਦਿਨ ਅਤੇ ਗਿਣਤੀ ਦਾ ਹਿਸਾਬ'], 'users'],
      ['ਵੋਟਰ ਨਾਲ ਪੰਜਾਬੀ ਅਤੇ ਹਿੰਦੀ ਵਿੱਚ ਗੱਲ', ['ਵੱਡੇ ਬਟਨਾਂ ਵਾਲਾ ਮੋਬਾਈਲ ਪੰਨਾ, ਆਵਾਜ਼ ਵਿੱਚ ਸੁਣਨ ਦੀ ਸਹੂਲਤ', 'ਸਹਾਇਕ ਸਿਰਫ਼ ਮਨਜ਼ੂਰ ਕੀਤੀ ਜਾਣਕਾਰੀ ਦੱਸਦਾ ਹੈ', 'ਵੋਟ ਦੀ ਥਾਂ ਅਤੇ ਤਾਰੀਖ਼ ਲਈ ਚੋਣ ਕਮਿਸ਼ਨ ਦਾ ਲਿੰਕ', 'ਹਰ ਕਾਲ ਤੋਂ ਪਹਿਲਾਂ ਨਿਯਮਾਂ ਦੀ ਜਾਂਚ'], 'phone'],
      ['ਜ਼ਮੀਨ ਤੇ ਕੰਮ, ਨੈੱਟ ਤੋਂ ਬਿਨਾਂ ਵੀ', ['ਬੂਥ ਵਰਕਰ ਦੀ ਐਪ ਬਿਨਾਂ ਸਿਗਨਲ ਚੱਲਦੀ ਹੈ', 'ਵੋਟਰ ਸੂਚੀ ਦੀ ਕਾਪੀ ਤੋਂ ਘਰਾਂ ਦੀ ਸੂਚੀ, ਸਰੋਤ ਦੇ ਸਬੂਤ ਸਮੇਤ', 'ਨਕਸ਼ੇ ਤੇ ਇਲਾਕੇ ਅਤੇ ਕੰਮ ਦੀ ਪ੍ਰਗਤੀ', 'ਰੈਲੀ ਅਤੇ ਸਭਾ ਦੀ ਇਜਾਜ਼ਤ ਦਾ ਹਿਸਾਬ'], 'map'],
      ['ਖ਼ਰਚੇ ਦਾ ਹਿਸਾਬ ਤਿਆਰ ਰਹੇ', ['ਹਰ ਖ਼ਰਚੇ ਦੀ ਰਸੀਦ ਦੀ ਫ਼ੋਟੋ ਨਾਲ ਜੁੜੀ', 'ਬੈਂਕ ਸਟੇਟਮੈਂਟ ਨਾਲ ਮਿਲਾਣ: ਕੀ ਰਹਿ ਗਿਆ, ਤੁਰੰਤ ਪਤਾ', 'ਖ਼ਰਚੇ ਦੀ ਹੱਦ ਦੇ ਨੇੜੇ ਪਹੁੰਚਣ ਤੇ ਚੇਤਾਵਨੀ', 'ਦਸਤਖ਼ਤ ਤੋਂ ਬਾਅਦ ਰਜਿਸਟਰ ਦਾ ਨਿਰਯਾਤ'], 'rupee'],
      ['ਨਿਯਮ ਪਲੇਟਫਾਰਮ ਵਿੱਚ ਹੀ ਬਣੇ ਹਨ', ['MCMC ਸਰਟੀਫ਼ਿਕੇਟ ਤੋਂ ਬਿਨਾਂ ਕੋਈ ਕਾਲ ਜਾਂ SMS ਨਹੀਂ', 'DLT ਟੈਂਪਲੇਟ ਤੋਂ ਬਿਨਾਂ SMS ਨਹੀਂ', 'ਵੋਟਿੰਗ ਤੋਂ 48 ਘੰਟੇ ਪਹਿਲਾਂ ਚੁੱਪ ਦੀ ਮਿਆਦ', 'ਸਹਿਮਤੀ ਅਤੇ "ਬੰਦ ਕਰੋ" ਦਾ ਸਤਿਕਾਰ', 'ਹਰ ਮੁਹਿੰਮ ਦਾ ਪੜ੍ਹਨ-ਯੋਗ, ਮੋਹਰ ਲੱਗਾ ਸਬੂਤ (PDF)'], 'shield'],
      ['ਡੇਟਾ ਦੀ ਸੁਰੱਖਿਆ ਦਾ ਵਾਅਦਾ', ['ਚੋਣ ਤੋਂ ਬਾਅਦ ਨਿੱਜੀ ਡੇਟਾ ਮਿਟਾਇਆ ਜਾਂਦਾ ਹੈ', 'ਜਾਤ ਜਾਂ ਧਰਮ ਦਾ ਕੋਈ ਡੇਟਾ ਨਹੀਂ', 'ਖ਼ਰੀਦੀਆਂ ਜਾਂ ਚੁੱਕੀਆਂ ਸੂਚੀਆਂ ਨਹੀਂ', 'ਇੱਕ ਸੀਟ, ਇੱਕ ਗਾਹਕ', 'WhatsApp ਆਟੋਮੇਸ਼ਨ ਨਹੀਂ'], 'lock'],
      ['ਸ਼ੁਰੂਆਤ ਕਿਵੇਂ ਹੁੰਦੀ ਹੈ', ['1. ਪੰਜਾਬ 2027 ਪੈਕੇਜ ਲਗਾਓ: ਖਰੜਾ ਪੰਨੇ ਅਤੇ ਪਹਿਲਾ ਸਰਵੇ ਤਿਆਰ', '2. ਉਮੀਦਵਾਰ ਸਮੱਗਰੀ ਭਰਦਾ ਅਤੇ ਮਨਜ਼ੂਰ ਕਰਦਾ ਹੈ', '3. MCMC ਸਰਟੀਫ਼ਿਕੇਟ ਅਤੇ DLT ਰਜਿਸਟਰੇਸ਼ਨ', '4. ਇੱਕ ਬੂਥ ਤੇ ਛੋਟਾ ਟੈਸਟ, ਫਿਰ ਪੂਰੀ ਮੁਹਿੰਮ'], 'flag'],
    ],
    closing: 'ਗੱਲ ਕਰਨ ਲਈ ਅਗਲਾ ਕਦਮ', closingSub: 'ਇੱਕ ਡੈਮੋ ਮੁਹਿੰਮ ਵੇਖੋ: ਵੋਟਰ ਪੰਨਾ, ਡੈਸ਼ਬੋਰਡ ਅਤੇ ਸਬੂਤ ਦਾ PDF',
  },
  hi: {
    file: 'Punjab2027_Pitch_Hindi.pptx', lang: 'hi-IN',
    title: 'पूरा अभियान, एक जगह', sub: 'पंजाब विधान सभा 2027 के लिए चुनाव अभियान प्लेटफ़ॉर्म', by: 'Wayne E Solutions',
    slides: [
      ['अभियान के सारे काम एक प्लेटफ़ॉर्म पर', ['मतदाता से संपर्क: पेज, सवाल-जवाब, कॉल और SMS', 'ज़मीनी काम: बूथ वर्कर, कार्यक्रम, वॉलंटियर', 'खर्च: चुनाव खर्च का रजिस्टर और रसीदें', 'नतीजे: मतदान दिवस और गिनती का हिसाब'], 'users'],
      ['मतदाता से पंजाबी और हिंदी में बात', ['बड़े बटनों वाला मोबाइल पेज, आवाज़ में सुनने की सुविधा', 'सहायक सिर्फ़ मंज़ूर की गई जानकारी बताता है', 'वोट की जगह और तारीख़ के लिए चुनाव आयोग का लिंक', 'हर कॉल से पहले नियमों की जाँच'], 'phone'],
      ['ज़मीन पर काम, नेट के बिना भी', ['बूथ वर्कर की ऐप बिना सिग्नल चलती है', 'मतदाता सूची की कॉपी से घरों की सूची, स्रोत के सबूत सहित', 'नक़्शे पर इलाक़े और काम की प्रगति', 'रैली और सभा की इजाज़त का हिसाब'], 'map'],
      ['खर्च का हिसाब तैयार रहे', ['हर खर्च की रसीद की फ़ोटो के साथ', 'बैंक स्टेटमेंट से मिलान: क्या छूटा, तुरंत पता', 'खर्च की सीमा के क़रीब पहुँचने पर चेतावनी', 'हस्ताक्षर के बाद रजिस्टर का निर्यात'], 'rupee'],
      ['नियम प्लेटफ़ॉर्म में ही बने हैं', ['MCMC प्रमाणपत्र के बिना कोई कॉल या SMS नहीं', 'DLT टेम्पलेट के बिना SMS नहीं', 'मतदान से 48 घंटे पहले चुप्पी की अवधि', 'सहमति और "बंद करो" का सम्मान', 'हर अभियान का पढ़ने-योग्य, मुहर लगा सबूत (PDF)'], 'shield'],
      ['डेटा की सुरक्षा का वादा', ['चुनाव के बाद निजी डेटा मिटा दिया जाता है', 'जाति या धर्म का कोई डेटा नहीं', 'ख़रीदी या चुराई गई सूचियाँ नहीं', 'एक सीट, एक ग्राहक', 'WhatsApp ऑटोमेशन नहीं'], 'lock'],
      ['शुरुआत कैसे होती है', ['1. पंजाब 2027 पैकेज लगाएँ: मसौदा पेज और पहला सर्वे तैयार', '2. उम्मीदवार सामग्री भरता और मंज़ूर करता है', '3. MCMC प्रमाणपत्र और DLT पंजीकरण', '4. एक बूथ पर छोटा टेस्ट, फिर पूरा अभियान'], 'flag'],
    ],
    closing: 'बात करने का अगला क़दम', closingSub: 'एक डेमो अभियान देखें: मतदाता पेज, डैशबोर्ड और सबूत का PDF',
  },
};

// Simple icons drawn from shapes, so no image files are needed.
function icon(slide, pptx, kind, x, y) {
  const o = (extra) => ({ objectName: `icon-${kind}`, ...extra });
  slide.addShape(pptx.ShapeType.ellipse, o({ x, y, w: 1.1, h: 1.1, fill: { color: GOLD } }));
  const shape = { users: pptx.ShapeType.flowChartMultidocument, phone: pptx.ShapeType.roundRect, map: pptx.ShapeType.flowChartPunchedTape, rupee: pptx.ShapeType.donut, shield: pptx.ShapeType.flowChartOffpageConnector, lock: pptx.ShapeType.roundRect, flag: pptx.ShapeType.rtTriangle }[kind];
  slide.addShape(shape, o({ x: x + 0.3, y: y + 0.28, w: 0.5, h: 0.55, fill: { color: NAVY }, line: { color: NAVY, width: 0 } }));
}

for (const [code, d] of Object.entries(DECKS)) {
  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = d.title; pptx.author = d.by; pptx.company = d.by;
  const text = (s, t, o) => s.addText(t, { isTextBox: true, fontFace: FONT, lang: d.lang, ...o });

  const cover = pptx.addSlide();
  cover.background = { color: NAVY };
  text(cover, d.title, { x: 0.8, y: 2.0, w: 11.7, h: 1.4, fontSize: 48, bold: true, color: 'FFFFFF', margin: 0, objectName: 'title' });
  text(cover, d.sub, { x: 0.8, y: 3.5, w: 11.7, h: 0.9, fontSize: 24, color: 'CADCFC', margin: 0, objectName: 'subtitle' });
  text(cover, d.by, { x: 0.8, y: 6.2, w: 8, h: 0.5, fontSize: 18, color: GOLD, bold: true, margin: 0, objectName: 'by' });

  d.slides.forEach(([title, bullets, ic], i) => {
    const s = pptx.addSlide();
    s.background = { color: i % 3 === 2 ? 'FFFFFF' : PAPER };
    icon(s, pptx, ic, 0.8, 0.7);
    text(s, title, { x: 2.2, y: 0.6, w: 10.3, h: 1.3, fontSize: 36, bold: true, color: NAVY, valign: 'middle', margin: 0, objectName: 'title' });
    text(s, bullets.map((b, k) => ({ text: b, options: { bullet: /^\d\./.test(b) ? false : true, breakLine: k < bullets.length - 1 } })), {
      x: 2.2, y: 2.3, w: 10.3, h: 4.3, fontSize: 24, color: INK, valign: 'top', margin: 0, paraSpaceAfter: 14, objectName: 'body',
    });
    text(s, `${i + 2}`, { x: 12.0, y: 6.9, w: 0.8, h: 0.4, fontSize: 12, color: SOFT, align: 'right', margin: 0, objectName: 'page' });
  });

  const end = pptx.addSlide();
  end.background = { color: NAVY };
  text(end, d.closing, { x: 0.8, y: 2.3, w: 11.7, h: 1.2, fontSize: 44, bold: true, color: 'FFFFFF', margin: 0, objectName: 'title' });
  text(end, d.closingSub, { x: 0.8, y: 3.7, w: 11.7, h: 1.2, fontSize: 24, color: 'CADCFC', margin: 0, objectName: 'subtitle' });
  text(end, d.by, { x: 0.8, y: 6.2, w: 8, h: 0.5, fontSize: 18, color: GOLD, bold: true, margin: 0, objectName: 'by' });

  pptx.writeFile({ fileName: d.file }).then((f) => console.log('wrote', f));
}
