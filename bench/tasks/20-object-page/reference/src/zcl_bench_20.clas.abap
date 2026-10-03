CLASS zcl_bench_20 DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES:
      BEGIN OF ty_s_supplier,
        name      TYPE string,
        country   TYPE string,
        lead_time TYPE i,
      END OF ty_s_supplier.
    TYPES:
      BEGIN OF ty_s_review,
        author TYPE string,
        text   TYPE string,
      END OF ty_s_review.
    DATA suppliers TYPE STANDARD TABLE OF ty_s_supplier WITH EMPTY KEY.
    DATA reviews   TYPE STANDARD TABLE OF ty_s_review WITH EMPTY KEY.

  PROTECTED SECTION.
    DATA client TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS model_init.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_bench_20 IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    me->client = client.
    IF client->check_on_init( ).
      model_init( ).
      view_display( ).
    ELSEIF client->check_on_navigated( ).
      view_display( ).
    ENDIF.

  ENDMETHOD.

  METHOD view_display.

    DATA(view) = z2ui5_cl_ui5_view_builder=>factory(
        )->ele( n = `View` ns = `mvc`
            )->a( n = `xmlns`        v = `sap.m`
            )->a( n = `xmlns:mvc`    v = `sap.ui.core.mvc`
            )->a( n = `xmlns:uxap`   v = `sap.uxap`
            )->a( n = `xmlns:form`   v = `sap.ui.layout.form`
            )->a( n = `displayBlock` v = `true`
            )->a( n = `height`       v = `100%` ).

    DATA(layout) = view->ele( `Shell`
        )->ele( n = `ObjectPageLayout` ns = `uxap`
            )->a( n = `showTitleInHeaderContent` v = `true` ).

    layout->ele( n = `headerTitle` ns = `uxap`
        )->ele( n = `ObjectPageHeader` ns = `uxap`
            )->a( n = `objectTitle`    v = `Ergo Screen E-I`
            )->a( n = `objectSubtitle` v = `Monitors` ).

    layout->ele( n = `headerContent` ns = `uxap`

        )->tag( `ObjectNumber`
            )->a( n = `number` v = `230.00`
            )->a( n = `unit`   v = `EUR`
        )->tag( `ObjectStatus`
            )->a( n = `text`  v = `Low stock`
            )->a( n = `state` v = `Warning` ).

    DATA(sections) = layout->ele( n = `sections` ns = `uxap` ).

    sections->ele( n = `ObjectPageSection` ns = `uxap`
        )->a( n = `title` v = `General information`
        )->ele( n = `subSections` ns = `uxap`
            )->ele( n = `ObjectPageSubSection` ns = `uxap`
                )->ele( n = `blocks` ns = `uxap`
                    )->ele( n = `SimpleForm` ns = `form`
                        )->a( n = `editable` v = `false`

                        )->ele( n = `content` ns = `form`

                            )->tag( `Label`
                                )->a( n = `text` v = `Product number`
                            )->tag( `Text`
                                )->a( n = `text` v = `HT-1010`
                            )->tag( `Label`
                                )->a( n = `text` v = `Weight`
                            )->tag( `Text`
                                )->a( n = `text` v = `4.2 KG`
                            )->tag( `Label`
                                )->a( n = `text` v = `Dimensions`
                            )->tag( `Text`
                                )->a( n = `text` v = `30 x 18 x 3 cm` ).

    DATA(table) = sections->ele( n = `ObjectPageSection` ns = `uxap`
        )->a( n = `title` v = `Suppliers`
        )->ele( n = `subSections` ns = `uxap`
            )->ele( n = `ObjectPageSubSection` ns = `uxap`
                )->ele( n = `blocks` ns = `uxap`
                    )->ele( `Table`
                        )->a( n = `items` v = client->_bind( suppliers ) ).

    table->ele( `columns`
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Name`
        )->end(
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Country`
        )->end(
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Lead time (days)` ).

    table->ele( `items`
        )->ele( `ColumnListItem`
            )->ele( `cells`

                )->tag( `Text`
                    )->a( n = `text` v = `{NAME}`
                )->tag( `Text`
                    )->a( n = `text` v = `{COUNTRY}`
                )->tag( `Text`
                    )->a( n = `text` v = `{LEAD_TIME}` ).

    sections->ele( n = `ObjectPageSection` ns = `uxap`
        )->a( n = `title` v = `Reviews`
        )->ele( n = `subSections` ns = `uxap`
            )->ele( n = `ObjectPageSubSection` ns = `uxap`
                )->ele( n = `blocks` ns = `uxap`
                    )->ele( `List`
                        )->a( n = `items` v = client->_bind( reviews )
                        )->tag( `FeedListItem`
                            )->a( n = `sender`   v = `{AUTHOR}`
                            )->a( n = `text`     v = `{TEXT}`
                            )->a( n = `showIcon` v = `false` ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD model_init.

    suppliers = VALUE #( ( name = `Display Parts Ltd.` country = `Taiwan`  lead_time = 21 )
                         ( name = `Screen Works GmbH`  country = `Germany` lead_time = 7 )
                         ( name = `Panel Source Inc.`  country = `USA`     lead_time = 14 ) ).

    reviews = VALUE #( ( author = `Anna S.`  text = `Sharp picture, easy to adjust.` )
                       ( author = `Peter J.` text = `Good value for the office.` )
                       ( author = `Maria R.` text = `The stand could be sturdier.` ) ).

  ENDMETHOD.

ENDCLASS.
