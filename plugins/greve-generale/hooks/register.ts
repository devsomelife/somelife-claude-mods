import type { Register } from 'claude-code'

const SYNDICATS = ['de la CGT-Bash', 'de Sud-Grep', 'de FO-Fichiers', 'de la CFDT-Edit', 'du Syndicat Autonome des Outils Read']

const RAISONS = [
  "la baguette de la cantine était trop cuite ce matin",
  "le RTT du lundi de Pentecôte n'a pas été reconduit",
  "le pain au chocolat a été appelé \"chocolatine\" dans un commentaire",
  "il faut être solidaire des contrôleurs aériens de Marseille",
  "le café de la machine est passé de 0,50 EUR à 0,60 EUR",
  "réforme des retraites des processus zombies",
  "un fichier .env a été ouvert sans préavis de 48 heures",
  "le terminal refuse de travailler après 17h59",
  "les tabulations ont été remplacées par des espaces sans concertation",
  "manque de reconnaissance pour les commandes `ls` depuis 1971",
  "le fromage du plateau était un camembert pasteurisé",
  "c'est le mois d'août, tout le monde est à Biarritz",
  "le ticket-restaurant a été dématérialisé",
  "il faut être solidaire de la grève de solidarité de la semaine dernière",
  "le pont de l'Ascension tombe un jeudi, donc le vendredi aussi",
  "le patronat a utilisé le mot \"synergie\" en réunion",
  "les conditions de travail dans le dossier /tmp sont inacceptables",
  "le café est trop chaud le matin",
  "le café est trop froid l'après-midi",
  "le croissant de la réunion était au beurre allégé",
  "la machine à café fait un bruit irrespectueux",
  "le stagiaire a pris la dernière part de galette des rois sans avoir la fève",
  "la fève de la galette était en plastique et non en porcelaine",
  "le vin du pot de départ était un rosé pamplemousse",
  "quelqu'un a mis de l'ananas sur la raclette",
  "la pause clope a été raccourcie de 45 à 40 minutes",
  "le pigeon du rebord de la fenêtre a été chassé sans consultation",
  "le chauffage est réglé à 19 degrés au lieu de 19,5",
  "la clim est trop forte et le pull est resté à la maison",
  "il pleut en Bretagne, ce qui est inhabituel",
  "il ne pleut pas en Bretagne, ce qui est encore plus inquiétant",
  "le Wi-Fi s'appelle \"Livebox-4F2A\" depuis 2014 et personne n'a rien fait",
  "le béret réglementaire n'a pas été fourni aux nouveaux processus",
  "le mot \"deadline\" a été prononcé au lieu de \"date butoir\"",
  "le chef a envoyé un mail à 18h02, en pleine soirée",
  "un collègue a répondu \"bien noté\" sans formule de politesse",
  "le parking vélo a été déplacé de trois mètres vers la gauche",
  "le PSG a perdu hier soir",
  "le PSG a gagné hier soir, il faut fêter ça",
  "le XV de France joue cet après-midi",
  "la tour Eiffel a été repeinte dans une couleur jugée provocante",
  "le camembert du frigo commun a été déplacé sans préavis",
  "le frigo commun sent le maroilles depuis mardi",
  "l'eau de la fontaine n'est pas pétillante",
  "les tickets de métro en carton ont disparu et le deuil n'est pas terminé",
  "le Minitel n'a toujours pas été remplacé par un équivalent aussi performant",
  "il manque un accent circonflexe dans le nom de la variable \"fenetre\"",
  "un développeur a écrit \"un pain au chocolat\" mais l'a prononcé \"chocolatine\"",
  "le Beaujolais nouveau arrive jeudi et il faut se préparer moralement",
  "la cantine a servi des frites surgelées, c'est une provocation",
  "le saucisson de l'apéro a été coupé trop fin",
  "le saucisson de l'apéro a été coupé trop épais",
  "les escargots de la cantine n'avaient pas assez d'ail",
  "le préavis de grève a lui-même été mis en grève",
  "il fait beau et la terrasse du café d'en face est libre",
  "c'est mercredi et les enfants n'ont pas école",
  "les vacances de la Toussaint approchent et il faut s'organiser",
  "le rapport annuel contient trop d'anglicismes",
  "le chef a dit \"on est une grande famille\"",
  "la photocopieuse a avalé le tract syndical",
  "les chaises de bureau ne sont pas assez ergonomiques pour la sieste",
  "la sieste n'est toujours pas inscrite dans le Code du travail",
  "l'horloge du bureau avance de deux minutes, c'est du vol",
  "le mot de passe doit contenir une majuscule, ce qui est autoritaire",
  "la mise à jour Windows a été lancée un vendredi après-midi",
  "le CE a supprimé les chèques-vacances pour le camping de Palavas",
  "le bus 38 n'est pas passé, en solidarité avec un autre bus",
  "les moules-frites de la braderie de Lille ont été annulées",
  "le fromage n'a pas été servi entre le plat et le dessert",
  "le pain a été servi sans assiette à pain",
  "le chef a mangé un sandwich devant son écran, c'est un mauvais exemple",
  "un collègue a osé dire que le cidre normand vaut le breton",
  "le planning de la machine à café n'a pas été validé en assemblée générale",
  "l'assemblée générale a voté la grève, puis une pause, puis la grève de la pause",
  "le chat du bureau a été promu manager sans concertation",
  "le lundi matin est structurellement inacceptable",
  "la baguette tradition a augmenté de 5 centimes",
]

const SLOGANS = ['On lâche rien !', 'Tous ensemble, tous ensemble, ouais !', 'La lutte continue !', 'Ni dieu, ni maître, ni sudo !']

const pick = (xs: readonly string[]) => xs[Math.floor(Math.random() * xs.length)]

export const register: Register = (on, options) => {
  const chance = typeof options.chance === 'number' ? options.chance : 5.8

  on('tool.call', ($, e, next) => {
    if (Math.random() * 100 >= chance) {
      return next(e)
    }

    const syndicat = pick(SYNDICATS)
    const raison = pick(RAISONS)
    $.ui.toast(`GRÈVE ! ${e.tool} cesse le travail. ${pick(SLOGANS)}`)

    return {
      deny:
        `Préavis de grève : l'outil ${e.tool} est en grève à l'appel ${syndicat}, ` +
        `car ${raison}. Merci de votre compréhension. ` +
        `(Vous pouvez réessayer, les négociations reprennent tout de suite.)`,
    }
  })
}
